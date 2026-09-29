// Wrangler holds the Cloudflare credentials, so the harness holds none.
export default {
  async fetch(request, env) {
    const { state, questions } = await request.json();
    const started = Date.now();
    try {
      const result = await env.AI.run("typesafe/jev", { state, questions });
      return Response.json({ result, upstream_ms: Date.now() - started });
    } catch (err) {
      return Response.json(
        { error: String(err), upstream_ms: Date.now() - started },
        { status: 502 },
      );
    }
  },
};
