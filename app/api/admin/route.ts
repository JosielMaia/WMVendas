const ADMIN_API = "https://ltkstlflqjqcuxzioaoa.supabase.co/functions/v1/wm-vendas-api";
const ADMIN_ACTIONS = new Set([
  "login", "logout", "session_check", "list", "store_admin", "update_store_settings",
  "update_store_order_status", "create_product", "update_product",
  "create_customer", "create_sale", "mark_paid", "create_supplier_bill",
  "mark_supplier_bill_paid",
]);

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const raw = await request.text();
    if (raw.length > 3_500_000) return Response.json({ error: "Solicitação muito grande." }, { status: 413 });
    const body = JSON.parse(raw || "{}");
    if (!ADMIN_ACTIONS.has(String(body.action || ""))) return Response.json({ error: "Ação não permitida." }, { status: 400 });
    const headers: Record<string,string> = {
      "content-type": "application/json",
      "user-agent": request.headers.get("user-agent") || "wm-vendas-admin",
      "x-forwarded-for": request.headers.get("x-forwarded-for") || "unknown",
    };
    const authorization = request.headers.get("authorization");
    if (authorization) headers.authorization = authorization;
    const response = await fetch(ADMIN_API, { method:"POST", headers, body:raw, cache:"no-store" });
    return new Response(await response.text(), {
      status: response.status,
      headers: { "content-type":"application/json; charset=utf-8", "cache-control":"no-store" },
    });
  } catch {
    return Response.json({ error: "Não foi possível conectar ao WM Vendas." }, { status: 502 });
  }
}
