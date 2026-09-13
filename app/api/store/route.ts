const STORE_API = "https://ltkstlflqjqcuxzioaoa.supabase.co/functions/v1/wm-vendas-api";
const PUBLIC_ACTIONS = new Set(["public_catalog", "create_store_order"]);

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const raw = await request.text();
    if (raw.length > 50_000) return Response.json({ error: "Solicitação muito grande." }, { status: 413 });
    const body = JSON.parse(raw || "{}");
    if (!PUBLIC_ACTIONS.has(String(body.action || ""))) return Response.json({ error: "Ação não permitida." }, { status: 400 });

    const response = await fetch(STORE_API, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": request.headers.get("user-agent") || "wm-vendas-store",
        "x-forwarded-for": request.headers.get("x-forwarded-for") || "unknown",
      },
      body: raw,
      cache: "no-store",
    });
    const text = await response.text();
    return new Response(text, {
      status: response.status,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  } catch {
    return Response.json({ error: "Não foi possível conectar à loja. Tente novamente." }, { status: 502 });
  }
}
