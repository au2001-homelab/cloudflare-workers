import { direct, literal } from "./direct.js";

const USAGE = "Usage: https://cors.arl.sh/<url>\n";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "*",
  // The wildcard covers every request header a caller might send bar one: the
  // Fetch standard makes an exception of `Authorization` and wants it by name.
  "Access-Control-Allow-Headers": "*, Authorization",
  "Access-Control-Expose-Headers": "*",
  "Access-Control-Max-Age": "86400",
};

function error(status, message) {
  return new Response(message, {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "text/plain",
    },
  });
}

async function proxy(request) {
  if (
    request.method === "OPTIONS" &&
    request.headers.has("Access-Control-Request-Method")
  ) {
    return new Response(null, {
      status: 204,
      headers: corsHeaders,
    });
  }

  const { origin } = new URL(request.url);
  const raw = request.url.slice(origin.length + 1);

  // Tolerate a collapsed scheme separator ("https:/example.com"), which some
  // clients produce when they normalize the path before sending it.
  const target = raw.replace(/^(https?:)\/(?!\/)/i, "$1//");
  if (!target) return error(400, USAGE);

  let url;
  try {
    url = new URL(target);
  } catch {
    return error(400, `Invalid target URL: ${target}\n\n${USAGE}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return error(400, `Unsupported protocol: ${url.protocol}\n\n${USAGE}`);
  }

  if (url.protocol === "https:" && literal(url.hostname)) {
    return error(
      400,
      `Cannot reach ${url.hostname} over HTTPS: direct IP addresses unsupported by the current runtime.\n\n${USAGE}`,
    );
  }

  const upstream = new Request(url, request);
  upstream.headers.delete("Host");

  let response;

  try {
    response = literal(url.hostname)
      ? await direct(upstream, url)
      : await fetch(upstream, { redirect: "manual" });
  } catch (cause) {
    return error(502, `Could not reach ${url}: ${cause.message}\n`);
  }

  const proxied = new Response(response.body, response);
  proxied.headers.delete("Access-Control-Allow-Credentials");

  for (const [name, value] of Object.entries(corsHeaders)) {
    proxied.headers.set(name, value);
  }

  const location = proxied.headers.get("Location");
  if (location !== null && response.status >= 300 && response.status < 400) {
    try {
      // Handle relative redirects by resolving the Location against the upstream URL.
      proxied.headers.set("Location", `${origin}/${new URL(location, url)}`);
    } catch {}
  }

  return proxied;
}

export default {
  fetch: proxy,
};
