"""Drive accreta's MCP server over stdio with the official MCP Python SDK.

Run from the repository root after `bun install`:

    pip install -r test/clients/python/requirements.txt
    pytest test/clients/python

check_drift and list_recent_changes are not exercised: they need git history a depth-1 checkout lacks.
"""

import json
import os
import re
import subprocess
from contextlib import asynccontextmanager
from pathlib import Path

import pytest
from mcp import ClientSession, MCPError, StdioServerParameters, stdio_client

REPO = Path(__file__).resolve().parents[3]
# The one place the server launch lives; change it here when the entry point moves.
SOURCE = "--conditions=@accreta/source"  # in the repository, packages resolve to src/
SERVER_COMMAND = ["bun", SOURCE, str(REPO / "packages" / "mcp-server" / "src" / "bin.ts")]
CLI = REPO / "packages" / "cli" / "src" / "bin.ts"
KB_ROOT = REPO / "examples" / "climate"
PAGES = sorted(p.relative_to(KB_ROOT).as_posix() for p in (KB_ROOT / "knowledge").rglob("*.md"))
SOURCE_IDS = {
    m.group(1)
    for f in (KB_ROOT / "sources").glob("*.yaml")
    if (m := re.search(r"^id:\s*(\S+)\s*$", f.read_text(), re.MULTILINE))
}

READ_TOOLS = {
    "check_drift",
    "find_canonical",
    "find_consumers",
    "get_page",
    "lint_knowledge_base",
    "list_recent_changes",
    "search_pages",
}
WRITE_TOOL = "update_verified_revision"

FOOTNOTE_DEF = re.compile(r"^\[\^[^\]]+\]:.*$", re.MULTILINE)
# The demo's configured provenance format: "{source} @ {rev} · {path}#{locator}".
FOOTNOTE = re.compile(
    r"\[\^[^\]]+\]: (?P<source>\S+) @ (?P<rev>[0-9a-f]{40}) · \S+#L\d+(?:-L\d+)?"
)
TIMEOUT_SECONDS = 30


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(scope="session")
def index_path(tmp_path_factory):
    # Built outside the corpus so the test never writes into examples/.
    path = tmp_path_factory.mktemp("index") / "index.sqlite"
    env = {**os.environ, "ACCRETA_ROOT": str(KB_ROOT), "ACCRETA_INDEX_PATH": str(path)}
    subprocess.run(["bun", SOURCE, str(CLI), "reindex"], env=env, check=True, timeout=120)
    return path


@asynccontextmanager
async def connect(index_path):
    # ACCRETA_ALLOW_WRITES stays unset: the SDK inherits only its own safe env list plus this.
    params = StdioServerParameters(
        command=SERVER_COMMAND[0],
        args=SERVER_COMMAND[1:],
        env={"ACCRETA_ROOT": str(KB_ROOT), "ACCRETA_INDEX_PATH": str(index_path)},
    )
    async with stdio_client(params) as (read, write):
        # mcp 2.2.0 waits forever by default; a hung server should fail the run, not stall it.
        async with ClientSession(read, write, read_timeout_seconds=TIMEOUT_SECONDS) as client:
            yield client, await client.initialize()


@asynccontextmanager
async def session(index_path):
    async with connect(index_path) as (client, _):
        yield client


def text_of(result):
    return "".join(block.text for block in result.content if block.type == "text")


async def call_json(client, name, arguments):
    result = await client.call_tool(name, arguments)
    assert not result.is_error, f"{name} returned an error: {text_of(result)[:300]}"
    return json.loads(text_of(result))


async def refusal_message(client, name, arguments):
    # The spec allows a refusal as either a tool error or a JSON-RPC error.
    try:
        result = await client.call_tool(name, arguments)
    except MCPError as error:
        return str(error)
    assert result.is_error, f"{name} was not refused: {text_of(result)[:300]}"
    return text_of(result)


@pytest.mark.anyio
async def test_initialize_reports_the_package_version(index_path):
    manifest = json.loads((REPO / "packages" / "mcp-server" / "package.json").read_text())
    async with connect(index_path) as (_, info):
        pass
    assert info.server_info.name == "accreta"
    assert info.server_info.version == manifest["version"]


@pytest.mark.anyio
async def test_lists_the_read_tools_and_hides_the_write_tool(index_path):
    async with session(index_path) as client:
        listed = await client.list_tools()
    names = {tool.name for tool in listed.tools}
    assert READ_TOOLS <= names
    assert WRITE_TOOL not in names
    for tool in listed.tools:
        assert tool.input_schema.get("type") == "object", tool.name


@pytest.mark.anyio
async def test_search_finds_the_page_and_labels_author_fields(index_path):
    async with session(index_path) as client:
        found = await call_json(client, "search_pages", {"query": "climate sensitivity", "limit": 5})
    paths = [hit["path"] for hit in found["results"]]
    assert "knowledge/concepts/climate-sensitivity.md" in paths
    assert found["count"] == len(found["results"])
    assert "results[].snippet" in found["_provenance"]["page_derived_fields"]


@pytest.mark.anyio
async def test_get_page_serves_every_body_intact_with_well_formed_citations(index_path):
    assert PAGES, "no pages found on disk"
    async with session(index_path) as client:
        for path in PAGES:
            found = await call_json(client, "get_page", {"path": path})
            assert found["found"] is True, path
            page = found["page"]
            assert page["path"] == path
            assert "page.body" in found["_provenance"]["page_derived_fields"]

            # Catches transport damage: encoding of "·", newline handling, truncation.
            raw = (KB_ROOT / path).read_bytes()
            assert raw.startswith(b"---\n"), path
            # Core's frontmatter split also consumes blank lines after the closing fence.
            expected = raw.split(b"\n---\n", 1)[1].lstrip(b"\n")
            assert page["body"].encode("utf-8") == expected, path

            for definition in FOOTNOTE_DEF.finditer(page["body"]):
                cite = FOOTNOTE.fullmatch(definition.group(0))
                assert cite, f"{path}: malformed citation {definition.group(0)!r}"
                assert cite["source"] in SOURCE_IDS, f"{path}: unknown source {cite['source']}"


@pytest.mark.anyio
async def test_get_page_resolves_a_wikilink_target_to_a_cited_page(index_path):
    async with session(index_path) as client:
        found = await call_json(client, "get_page", {"path": "concepts/climate-sensitivity"})
    assert found["page"]["path"] == "knowledge/concepts/climate-sensitivity.md"
    assert FOOTNOTE.search(found["page"]["body"]), "page body carries no citation"


@pytest.mark.anyio
async def test_get_page_reports_a_missing_page_without_erroring(index_path):
    async with session(index_path) as client:
        found = await call_json(client, "get_page", {"path": "concepts/does-not-exist"})
    assert found["found"] is False


@pytest.mark.anyio
async def test_link_graph_and_lint_tools_answer(index_path):
    async with session(index_path) as client:
        consumers = await call_json(client, "find_consumers", {"target": "concepts/climate-sensitivity"})
        canonical = await call_json(client, "find_canonical", {"term": "ECS"})
        lint = await call_json(client, "lint_knowledge_base", {})
    assert consumers["target_exists"] is True
    assert "knowledge/concepts/climate-sensitivity.md" in [m["path"] for m in canonical["results"]]
    assert lint["pages_checked"] == len(PAGES)


@pytest.mark.anyio
async def test_unknown_tool_is_refused_and_the_session_survives(index_path):
    async with session(index_path) as client:
        message = await refusal_message(client, "no_such_tool", {})
        assert "no_such_tool" in message
        await call_json(client, "search_pages", {"query": "albedo"})


@pytest.mark.anyio
async def test_invalid_arguments_are_refused_and_the_session_survives(index_path):
    async with session(index_path) as client:
        message = await refusal_message(client, "search_pages", {"query": ""})
        assert "query" in message
        await call_json(client, "search_pages", {"query": "albedo"})
