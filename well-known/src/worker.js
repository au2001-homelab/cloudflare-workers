import * as wellknown from "./well-known.js";

async function fetch(request) {
  const { hostname, pathname } = new URL(request.url);

  if (pathname.startsWith("/.well-known/") && hostname in wellknown) {
    const key = pathname.substring(13);
    const file = wellknown[hostname][key];
    if (file) return new Response(file);
  }

  return new Response(null, {
    status: 404,
  });
}

export default {
  fetch,
};
