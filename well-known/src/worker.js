import * as wellknown from "./well-known.js";

async function fetch(request) {
  const { hostname, pathname } = new URL(request.url);

  if (pathname.startsWith("/.well-known/") && hostname in wellknown) {
    const data = wellknown[hostname][pathname.substring(13)];
    switch (typeof data) {
      case "string":
        return new Response(data);

      case "object":
        return new Response(JSON.stringify(data), {
          headers: {
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
