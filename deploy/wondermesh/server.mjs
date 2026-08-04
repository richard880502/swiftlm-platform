import http from "node:http";

const listenPort = Number(process.env.PORT || 8080);
const upstreamHost = process.env.UPSTREAM_HOST || "192.168.5.2";
const upstreamPort = Number(process.env.UPSTREAM_PORT || 18123);

const server = http.createServer((request, response) => {
  const headers = { ...request.headers, host: `${upstreamHost}:${upstreamPort}` };
  const upstream = http.request(
    {
      hostname: upstreamHost,
      port: upstreamPort,
      method: request.method,
      path: request.url,
      headers,
    },
    (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    },
  );

  upstream.setTimeout(0);
  upstream.on("error", (error) => {
    if (!response.headersSent) {
      response.writeHead(502, { "content-type": "application/json" });
    }
    response.end(JSON.stringify({ error: "SwiftLM upstream unavailable", detail: error.message }));
  });

  request.on("aborted", () => upstream.destroy());
  request.pipe(upstream);
});

server.requestTimeout = 0;
server.headersTimeout = 0;
server.keepAliveTimeout = 65_000;

server.listen(listenPort, "0.0.0.0", () => {
  console.log(`SwiftLM proxy listening on 0.0.0.0:${listenPort}`);
  console.log(`Upstream: http://${upstreamHost}:${upstreamPort}`);
});
