"""Drive accreta's MCP server over stdio with the official MCP Python SDK.

Run from the repository root after `bun install`:

    pip install -r test/clients/python/requirements.txt
    pytest test/clients/python
"""

import json
import os
import re
import subprocess
from contextlib import asynccontextmanager
from pathlib import Path

import pytest
from mcp import ClientSession, StdioServerParameters, stdio_client

REPO = Path(__file__).resolve().parents[3]
# The one place the server launch lives; change it here when the entry point moves.
SERVER_COMMAND = ["bun", "run", str(REPO / "packages" / "mcp-server" / "src" / "main.ts")]
CLI = REPO / "packages" / "cli" / "src" / "main.ts"
KB_ROOT = REPO / "examples" / "climate"

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

# The demo's configured provenance format: "{source} @ {rev} · {path}#{locator}".
FOOTNOTE = re.compile(
    r"^\[\^[^\]]+\]: (?P<source>\S+) @ (?P<rev>[0-9a-f]{40}) · (?P<path>\S+)#L(?P<start>\d+)(?:-L(?P<end>\d+))?$",
    re.MULTILINE,
)


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(scope="session")
def index_path(tmp_path_factory):
    # Built outside the corpus so the test never writes into examples/.
    path = tmp_path_factory.mktemp("index") / "index.sqlite"
    env = {**os.environ, "ACCRETA_ROOT": str(KB_ROOT), "ACCRETA_INDEX_PATH": str(path)}
    subprocess.run(["bun", "run", str(CLI), "reindex"], env=env, check=True)
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
        async with ClientSession(read, write) as client:
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
    assert names == READ_TOOLS
    assert WRITE_TOOL not in names
    for tool in listed.tools:
        assert tool.input_schema.get("type") == "object", tool.name


@pytest.mark.anyio
async def test_search_hits_carry_a_verified_revision(index_path):
    async with session(index_path) as client:
        found = await call_json(client, "search_pages", {"query": "climate sensitivity", "limit": 5})
    paths = [hit["path"] for hit in found["results"]]
    assert "knowledge/concepts/climate-sensitivity.md" in paths
    assert found["count"] == len(found["results"])
    for hit in found["results"]:
        assert re.fullmatch(r"[0-9a-f]{40}", hit["last_verified_revision"] or ""), hit["path"]
    assert "results[].snippet" in found["_provenance"]["page_derived_fields"]


@pytest.mark.anyio
async def test_get_page_returns_citations_that_resolve(index_path):
    async with session(index_path) as client:
        found = await call_json(client, "get_page", {"path": "concepts/climate-sensitivity"})
    assert found["found"] is True
    page = found["page"]
    assert page["path"] == "knowledge/concepts/climate-sensitivity.md"
    assert page["canonical_source"].startswith(f"{page['source']}:")
    assert "page.body" in found["_provenance"]["page_derived_fields"]

    citations = list(FOOTNOTE.finditer(page["body"]))
    assert citations, "page body carries no citation in the configured format"
    for cite in citations:
        assert cite["source"] == page["source"]
        assert cite["rev"] == page["last_verified_revision"]
        # Paths are relative to the git root the source declares, which is the repository here.
        lines = (REPO / cite["path"]).read_text().splitlines()
        end = int(cite["end"] or cite["start"])
        assert 1 <= int(cite["start"]) <= end <= len(lines), cite.group(0)


@pytest.mark.anyio
async def test_get_page_reports_a_missing_page_without_erroring(index_path):
    async with session(index_path) as client:
        found = await call_json(client, "get_page", {"path": "concepts/does-not-exist"})
    assert found["found"] is False


@pytest.mark.anyio
async def test_unknown_tool_is_refused_as_a_tool_error(index_path):
    async with session(index_path) as client:
        result = await client.call_tool("no_such_tool", {})
    assert result.is_error
    assert "no_such_tool not found" in text_of(result)


@pytest.mark.anyio
async def test_invalid_arguments_are_rejected_by_the_server(index_path):
    async with session(index_path) as client:
        result = await client.call_tool("search_pages", {"query": ""})
    assert result.is_error
    assert "Input validation error" in text_of(result)
