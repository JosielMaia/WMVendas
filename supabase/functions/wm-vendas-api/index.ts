import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.95.0";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: cors });
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
async function sha(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
async function requireSession(req: Request) {
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const tokenHash = await sha(token);
  const { data } = await db.from("wm_sessions").select("id").eq("token_hash", tokenHash).gt("expires_at", new Date().toISOString()).maybeSingle();
  if (data) await db.from("wm_sessions").update({ last_seen_at: new Date().toISOString() }).eq("id", data.id);
  return data ? { id: data.id, tokenHash } : null;
}
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply({ error: "Método não permitido" }, 405);
  try {
    const body = await req.json();
    const action = String(body.action || "");
    if (action === "login") {
      const pin = String(body.pin || "");
      if (!/^\d{6}$/.test(pin)) return reply({ error: "Digite os 6 números do PIN." }, 400);
      const clientKey = await sha((req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for") || "unknown") + "|" + (req.headers.get("user-agent") || ""));
      const since = new Date(Date.now() - 15 * 60_000).toISOString();
      const { count } = await db.from("wm_login_attempts").select("*", { count: "exact", head: true }).eq("client_key", clientKey).eq("succeeded", false).gte("attempted_at", since);
      if ((count || 0) >= 5) return reply({ error: "Muitas tentativas. Aguarde 15 minutos." }, 429);
      const { data: valid, error: verifyError } = await db.rpc("wm_verify_pin", { p_pin: pin });
      if (verifyError) throw verifyError;
      await db.from("wm_login_attempts").insert({ client_key: clientKey, succeeded: !!valid });
      if (!valid) return reply({ error: "PIN incorreto." }, 401);
      const token = randomToken();
      await db.from("wm_sessions").insert({ token_hash: await sha(token), expires_at: new Date(Date.now() + 30 * 86400_000).toISOString() });
      return reply({ token });
    }
    const session = await requireSession(req);
    if (!session) return reply({ error: "Sessão expirada. Entre novamente." }, 401);
    if (action === "logout") {
      await db.from("wm_sessions").delete().eq("id", session.id);
      return reply({ success: true });
    }
    if (action === "list") {
      const [pr, cr, rr, sr] = await Promise.all([
        db.from("wm_products").select("*").order("id", { ascending: false }),
        db.from("wm_customers").select("*").order("name"),
        db.from("wm_receivables").select("id,amount,due_date,status,installment_number,wm_customers(name,phone)").eq("status", "pending").order("due_date"),
        db.from("wm_sales").select("total,cost_total")
      ]);
      for (const result of [pr, cr, rr, sr]) if (result.error) throw result.error;
      const products = pr.data || [], sales = sr.data || [], today = new Date().toISOString().slice(0, 10);
      const charges = (rr.data || []).map((r: any) => ({ id:r.id, amount:Number(r.amount), dueDate:r.due_date, status:r.due_date<today?"overdue":"upcoming", installmentNumber:r.installment_number, customerName:r.wm_customers?.name||"Cliente", phone:r.wm_customers?.phone||"" }));
      const investment = products.reduce((sum:number,p:any)=>sum+Number(p.cost_price)*p.stock,0);
      const expectedRevenue = products.reduce((sum:number,p:any)=>sum+Number(p.sale_price)*p.stock,0);
      const pending = charges.reduce((sum:number,r:any)=>sum+r.amount,0);
      return reply({
        products:await Promise.all(products.map(async(p:any)=>({id:p.id,barcode:p.barcode,name:p.name,brand:p.brand,costPrice:Number(p.cost_price),salePrice:Number(p.sale_price),stock:p.stock,photoUrl:p.photo_path?(await db.storage.from("wm-product-images").createSignedUrl(p.photo_path,3600)).data?.signedUrl||null:null}))),
        customers:(cr.data||[]).map((c:any)=>({id:c.id,name:c.name,phone:c.phone})),
        charges,
        dashboard:{investment,expectedRevenue,expectedProfit:expectedRevenue-investment,salesTotal:sales.reduce((s:number,x:any)=>s+Number(x.total),0),received:0,pending,overdueCount:charges.filter((c:any)=>c.status==="overdue").length}
      });
    }
    if (action === "create_product") {
      const barcode=String(body.barcode||"").trim(), name=String(body.name||"").trim();
      if(!barcode||!name)return reply({error:"Informe o código e o nome do produto."},400);
      let photoPath:string|null=null;
      const photo=String(body.photo||"");
      if(photo){
        const match=photo.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
        if(!match)return reply({error:"Formato de foto inválido. Use JPG, PNG ou WebP."},400);
        const bytes=Uint8Array.from(atob(match[2]),c=>c.charCodeAt(0));
        if(bytes.byteLength>2*1024*1024)return reply({error:"A foto deve ter no máximo 2 MB."},400);
        const ext=match[1]==="image/png"?"png":match[1]==="image/webp"?"webp":"jpg";
        photoPath=`${crypto.randomUUID()}.${ext}`;
        const {error:uploadError}=await db.storage.from("wm-product-images").upload(photoPath,bytes,{contentType:match[1],cacheControl:"3600",upsert:false});
        if(uploadError)throw uploadError;
      }
      const { error }=await db.from("wm_products").insert({barcode,name,brand:String(body.brand||"Outros"),cost_price:Number(body.costPrice||0),sale_price:Number(body.salePrice||0),stock:Math.max(0,Number(body.stock||0)),photo_path:photoPath});
      if(error){
        if(photoPath)await db.storage.from("wm-product-images").remove([photoPath]);
        if(error.code==="23505")return reply({error:"Este código já está cadastrado."},409);
        throw error
      }
      return reply({message:"Produto cadastrado com sucesso"});
    }
    if (action === "update_product") {
      const id=Number(body.id), barcode=String(body.barcode||"").trim(), name=String(body.name||"").trim();
      if(!Number.isInteger(id)||id<1||!barcode||!name)return reply({error:"Produto inválido. Confira o código e o nome."},400);
      const {data:current,error:findError}=await db.from("wm_products").select("photo_path").eq("id",id).maybeSingle();
      if(findError)throw findError;
      if(!current)return reply({error:"Produto não encontrado."},404);
      const oldPhotoPath=current.photo_path as string|null;
      let nextPhotoPath=oldPhotoPath,uploadedPhotoPath:string|null=null;
      const photo=String(body.photo||"");
      if(photo){
        const match=photo.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
        if(!match)return reply({error:"Formato de foto inválido. Use JPG, PNG ou WebP."},400);
        const bytes=Uint8Array.from(atob(match[2]),c=>c.charCodeAt(0));
        if(bytes.byteLength>2*1024*1024)return reply({error:"A foto deve ter no máximo 2 MB."},400);
        const ext=match[1]==="image/png"?"png":match[1]==="image/webp"?"webp":"jpg";
        uploadedPhotoPath=`${crypto.randomUUID()}.${ext}`;
        const {error:uploadError}=await db.storage.from("wm-product-images").upload(uploadedPhotoPath,bytes,{contentType:match[1],cacheControl:"3600",upsert:false});
        if(uploadError)throw uploadError;
        nextPhotoPath=uploadedPhotoPath;
      }else if(body.removePhoto===true){nextPhotoPath=null}
      const {error}=await db.from("wm_products").update({barcode,name,brand:String(body.brand||"Outros"),cost_price:Number(body.costPrice||0),sale_price:Number(body.salePrice||0),stock:Math.max(0,Number(body.stock||0)),photo_path:nextPhotoPath}).eq("id",id);
      if(error){
        if(uploadedPhotoPath)await db.storage.from("wm-product-images").remove([uploadedPhotoPath]);
        if(error.code==="23505")return reply({error:"Este código já está cadastrado em outro produto."},409);
        throw error
      }
      if(oldPhotoPath&&oldPhotoPath!==nextPhotoPath)await db.storage.from("wm-product-images").remove([oldPhotoPath]);
      return reply({message:"Produto atualizado com sucesso"});
    }
    if (action === "create_customer") {
      const name=String(body.name||"").trim();if(!name)return reply({error:"Informe o nome da cliente."},400);
      const {error}=await db.from("wm_customers").insert({name,phone:String(body.phone||"")});if(error)throw error;
      return reply({message:"Cliente cadastrada com sucesso"});
    }
    if (action === "create_sale") {
      const {error}=await db.rpc("wm_register_sale",{p_product_id:Number(body.productId),p_customer_id:body.customerId?Number(body.customerId):null,p_quantity:Number(body.quantity||1),p_payment_method:String(body.paymentMethod||"pix"),p_installments:Number(body.installments||1),p_due_date:String(body.dueDate||new Date().toISOString().slice(0,10))});
      if(error)return reply({error:error.message},400);
      return reply({message:"Venda registrada com sucesso"});
    }
    if (action === "mark_paid") {
      const {error}=await db.from("wm_receivables").update({status:"paid",paid_at:new Date().toISOString()}).eq("id",Number(body.id));if(error)throw error;
      return reply({message:"Pagamento confirmado"});
    }
    return reply({ error: "Ação inválida." }, 400);
  } catch (error) {
    console.error(error);
    return reply({ error: "Não foi possível concluir. Tente novamente." }, 500);
  }
});
