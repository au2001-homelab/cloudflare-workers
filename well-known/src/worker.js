import * as wellknown from "./well-known.js";

const headers = {
  "Cache-Control": "no-cache",
};

async function fetch(request) {
  const { hostname, pathname } = new URL(request.url);

  if (pathname.startsWith("/.well-known/") && hostname in wellknown) {
    const data = wellknown[hostname][pathname.substring(13)];
    switch (typeof data) {
      case "string":
        return new Response(data, {
          headers,
        });

      case "object":
        return new Response(JSON.stringify(data), {
          headers: {
            ...headers,
            "Content-Type": "application/json",
          },
        });
    }
  }

  return new Response(null, {
    status: 404,
  });
}

export default {
  fetch,
};
