import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.95.0";

const allowedOrigins = new Set([
  "https://wm-vendas.vercel.app",
  "https://wm-vendas.aglow-box-0101.chatgpt.site",
]);
const corsBase = {
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const authClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { auth: { persistSession: false, autoRefreshToken: false } });
const WM_TENANT_SLUG = "wm-vendas";
let wmTenantIdCache = "";
async function getWmTenantId() {
  if (wmTenantIdCache) return wmTenantIdCache;
  const { data, error } = await db.from("wm_tenants").select("id").eq("slug", WM_TENANT_SLUG).eq("active", true).maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Tenant WM Vendas não encontrado.");
  wmTenantIdCache = data.id as string;
  return wmTenantIdCache;
}
async function getPublicTenantId(value:unknown){
  const slug=tenantSlug(String(value||WM_TENANT_SLUG))||WM_TENANT_SLUG;
  const {data,error}=await db.from("wm_tenants").select("id,subscription_status,trial_ends_at,grace_until").eq("slug",slug).eq("active",true).maybeSingle();
  if(error)throw error;if(!data)throw new Error("Loja não encontrada.");
  const now=Date.now(),trialOk=data.subscription_status==="trialing"&&(!data.trial_ends_at||new Date(data.trial_ends_at).getTime()>=now),graceOk=data.subscription_status==="past_due"&&data.grace_until&&new Date(data.grace_until).getTime()>=now;
  if(!["active"].includes(data.subscription_status)&&!trialOk&&!graceOk)throw new Error("Esta loja está temporariamente indisponível.");
  return data.id as string;
}
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
  const { data } = await db.from("wm_sessions").select("id,last_seen_at,tenant_id,user_id,member_id,role").eq("token_hash", tokenHash).gt("expires_at", new Date().toISOString()).maybeSingle();
  if (data && (!data.last_seen_at || Date.now()-new Date(data.last_seen_at).getTime()>300000)) await db.from("wm_sessions").update({ last_seen_at: new Date().toISOString() }).eq("id", data.id);
  return data ? { id: data.id, tokenHash, tenantId: data.tenant_id as string, userId:data.user_id as string|null, memberId:data.member_id as string|null, role:data.role as string|null } : null;
}
function tenantSlug(value:string){return value.normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"").slice(0,48)}
function tenantCanOperate(tenant:any){const now=Date.now();if(tenant?.subscription_status==="active")return true;if(tenant?.subscription_status==="trialing")return !tenant.trial_ends_at||new Date(tenant.trial_ends_at).getTime()>=now;if(tenant?.subscription_status==="past_due")return !!tenant.grace_until&&new Date(tenant.grace_until).getTime()>=now;return false}
const businessSegments:Record<string,Set<string>>={
  commerce:new Set(["beauty_jewelry","fashion","footwear","general_retail"]),
  food:new Set(["confectionery","sweets_savories","bakery","meals"]),
  services:new Set(["beauty_services","maintenance","professional_services"]),
};
function businessProfile(activityValue:unknown,segmentValue:unknown){
  const activity=String(activityValue||"commerce"),segment=String(segmentValue||"general_retail");
  if(!businessSegments[activity]?.has(segment))return null;
  return {activity,segment};
}

const sellerActions=new Set(["session_check","list","barcode_lookup","logout","create_customer","create_sale","create_express_sale","create_product","update_product","mark_paid","update_store_order_status"]);
const viewerActions=new Set(["session_check","list","barcode_lookup","logout"]);
function canRun(role:string,action:string){return role==="owner"||role==="admin"||(role==="seller"&&sellerActions.has(action))||(role==="viewer"&&viewerActions.has(action))}
async function audit(session:{tenantId:string;userId:string|null;memberId:string|null;role:string|null},eventType:string,entityType:string,entityId:string|null,metadata:Record<string,unknown>={}){
  await db.from("wm_audit_events").insert({tenant_id:session.tenantId,actor_type:session.userId?"user":"legacy_pin",actor_id:session.userId||session.memberId||null,event_type:eventType,entity_type:entityType,entity_id:entityId,metadata:{role:session.role||"owner",...metadata}});
}

function pixField(id: string, value: string) {
  return id + String(value.length).padStart(2, "0") + value;
}
function pixText(value: string, max: number) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Za-z0-9 ]/g, "").trim().toUpperCase().slice(0, max);
}
function pixCrc(payload: string) {
  let crc = 0xffff;
  for (let i = 0; i < payload.length; i++) {
    crc ^= payload.charCodeAt(i) << 8;
    for (let bit = 0; bit < 8; bit++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}
function buildPixPayload(key: string, holder: string, city: string, amount: number, reference: string) {
  const merchant = pixField("00", "BR.GOV.BCB.PIX") + pixField("01", key.trim());
  let payload = pixField("00", "01") + pixField("26", merchant) + pixField("52", "0000") + pixField("53", "986");
  payload += pixField("54", amount.toFixed(2)) + pixField("58", "BR");
  payload += pixField("59", pixText(holder, 25) || "WM VENDAS");
  payload += pixField("60", pixText(city, 15) || "SAO PAULO");
  payload += pixField("62", pixField("05", pixText(reference, 25) || "***"));
  payload += "6304";
  return payload + pixCrc(payload);
}

Deno.serve(async (req) => {
  const requestOrigin = req.headers.get("origin") || "";
  const allowedOrigin = allowedOrigins.has(requestOrigin)
    ? requestOrigin
    : "https://wm-vendas.vercel.app";
  const cors = { ...corsBase, "Access-Control-Allow-Origin": allowedOrigin, "Vary": "Origin" };
  const reply = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: cors });
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply({ error: "Método não permitido" }, 405);
  try {
    const body = await req.json();
    const action = String(body.action || "");

    if(action==="signup_owner")return reply({error:"Novas lojas são liberadas pela administração. Entre em contato pelo WhatsApp (91) 98485-5557."},403);

    if (action === "public_catalog") {
      const tenantId = await getPublicTenantId(body.storeSlug);
      const { error: expireError } = await db.rpc("wm_expire_store_reservations", { p_tenant_id: tenantId });
      if (expireError) throw expireError;
      const [{ data: settings, error: settingsError }, { data: products, error: productsError }, {data:tenantProfile,error:profileError}] = await Promise.all([
        db.from("wm_store_settings").select("store_name,whatsapp,store_enabled,logo_url,logo_path,primary_color,accent_color,slogan").eq("tenant_id", tenantId).maybeSingle(),
        db.from("wm_products").select("id,name,brand,sale_price,stock,photo_path,catalog_image_url").eq("tenant_id", tenantId).gt("sale_price", 0).gt("stock", 0).order("name"),
        db.from("wm_tenants").select("business_activity,business_segment").eq("id",tenantId).single()
      ]);
      if (settingsError) throw settingsError;
      if (productsError) throw productsError;
      if (profileError) throw profileError;
      if (!settings) throw new Error("Configurações da loja WM Vendas não encontradas.");
      const catalog = await Promise.all((products || []).map(async (p: any) => ({
        id: p.id,
        name: p.name,
        brand: p.brand,
        price: Number(p.sale_price),
        stock: p.stock,
        photoUrl: p.photo_path ? (await db.storage.from("wm-product-images").createSignedUrl(p.photo_path, 3600)).data?.signedUrl || null : p.catalog_image_url || null
      })));
      const logoUrl=settings.logo_path?(await db.storage.from("wm-store-assets").createSignedUrl(settings.logo_path,3600)).data?.signedUrl||null:settings.logo_url||null;
      return reply({ store: { name: settings.store_name, whatsapp: settings.whatsapp, enabled: settings.store_enabled,logoUrl,primaryColor:settings.primary_color,accentColor:settings.accent_color,slogan:settings.slogan,activity:tenantProfile.business_activity,segment:tenantProfile.business_segment }, products: catalog });
    }

    if (action === "create_store_order") {
      const tenantId = await getPublicTenantId(body.storeSlug);
      const paymentMethod = String(body.paymentMethod || "pix");
      if (!["pix", "reservation", "deposit"].includes(paymentMethod)) return reply({ error: "Forma de pagamento inválida." }, 400);
      const depositPercent = paymentMethod === "deposit" ? Number(body.depositPercent) : null;
      if (paymentMethod === "deposit" && ![20, 30].includes(depositPercent as number)) return reply({ error: "Escolha uma entrada de 20% ou 30%." }, 400);
      const { data: settings, error: settingsError } = await db.from("wm_store_settings").select("*").eq("tenant_id", tenantId).maybeSingle();
      if (settingsError) throw settingsError;
      if (!settings) throw new Error("Configurações da loja não encontradas.");
      if (!settings.store_enabled) return reply({ error: "A loja está temporariamente fechada." }, 503);
      if (paymentMethod === "pix" && !String(settings.pix_key || "").trim()) return reply({ error: "O PIX da loja ainda não foi configurado." }, 503);
      const orderClientKey = await sha((req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for") || "unknown") + "|" + (req.headers.get("user-agent") || ""));
      const orderWindow = new Date(Date.now() - 60 * 60_000).toISOString();
      const { count: recentOrders } = await db.from("wm_store_order_attempts").select("*", { count: "exact", head: true }).eq("tenant_id", tenantId).eq("client_key", orderClientKey).gte("attempted_at", orderWindow);
      if ((recentOrders || 0) >= 10) return reply({ error: "Muitos pedidos neste aparelho. Tente novamente mais tarde." }, 429);
      const items = Array.isArray(body.items) ? body.items.slice(0, 30) : [];
      const { data: order, error: orderError } = await db.rpc("wm_create_store_order_v2", {
        p_tenant_id: tenantId,
        p_customer_name: String(body.customerName || ""),
        p_phone: String(body.phone || ""),
        p_delivery_type: String(body.deliveryType || "retirada"),
        p_address: String(body.address || ""),
        p_payment_method: paymentMethod,
        p_items: items
      });
      if (orderError) return reply({ error: orderError.message }, 400);
      await db.from("wm_store_order_attempts").insert({ tenant_id: tenantId, client_key: orderClientKey });
      const reference = `WM${order.id}`;
      const total = Number(order.total);
      const depositAmount = paymentMethod === "deposit" ? Math.round(total * (depositPercent as number)) / 100 : null;
      const balanceDue = depositAmount === null ? null : Math.round((total - depositAmount) * 100) / 100;
      const pixAmount = paymentMethod === "deposit" ? depositAmount : total;
      const pixPayload = ["pix", "deposit"].includes(paymentMethod)
        ? buildPixPayload(String(settings.pix_key), String(settings.pix_holder_name), String(settings.pix_city), Number(pixAmount), reference)
        : null;
      if (pixPayload || paymentMethod === "deposit") {
        const { error: updateError } = await db.from("wm_store_orders").update({
          pix_payload: pixPayload,
          deposit_percent: depositPercent,
          deposit_amount: depositAmount,
          balance_due: balanceDue,
          updated_at: new Date().toISOString()
        }).eq("id", order.id).eq("tenant_id", tenantId);
        if (updateError) throw updateError;
      }
      return reply({
        order: { id: order.id, publicId: order.publicId, total, reference, status: order.status, paymentMethod, depositPercent, depositAmount, balanceDue },
        pix: pixPayload ? { key: settings.pix_key, holder: settings.pix_holder_name, payload: pixPayload } : null,
        whatsapp: settings.whatsapp
      }, 201);
    }
    if (action === "signup_owner") {
      const email=String(body.email||"").trim().toLowerCase(),password=String(body.password||""),ownerName=String(body.ownerName||"").trim(),storeName=String(body.storeName||"").trim(),phone=String(body.phone||"").trim();
      const signupKey=await sha((req.headers.get("cf-connecting-ip")||req.headers.get("x-forwarded-for")||"unknown")+"|"+(req.headers.get("user-agent")||""));
      const signupSince=new Date(Date.now()-60*60_000).toISOString();
      const {count:signupCount}=await db.from("wm_signup_attempts").select("*",{count:"exact",head:true}).eq("client_key",signupKey).gte("attempted_at",signupSince);
      if((signupCount||0)>=3)return reply({error:"Muitas tentativas de cadastro. Aguarde uma hora."},429);
      let slug=tenantSlug(String(body.slug||storeName));
      if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||password.length<8||ownerName.length<2||storeName.length<2)return reply({error:"Informe nome, loja, e-mail válido e senha com pelo menos 8 caracteres."},400);
      if(slug.length<3)return reply({error:"Escolha um nome de loja com pelo menos 3 caracteres."},400);
      const {data:slugExists}=await db.from("wm_tenants").select("id").eq("slug",slug).maybeSingle();
      if(slugExists)slug=`${slug}-${crypto.randomUUID().slice(0,5)}`;
      const {data:signupAttempt}=await db.from("wm_signup_attempts").insert({client_key:signupKey}).select("id").single();
      const {data:created,error:createError}=await db.auth.admin.createUser({email,password,email_confirm:true,user_metadata:{name:ownerName}});
      if(createError)return reply({error:createError.message.includes("already")?"Este e-mail já possui uma conta.":"Não foi possível criar a conta."},400);
      const userId=created.user?.id;
      if(!userId)return reply({error:"Não foi possível criar a conta."},500);
      let tenantId="";
      try{
        const {data:tenant,error:tenantError}=await db.from("wm_tenants").insert({slug,name:storeName,owner_name:ownerName,owner_phone:phone,plan_code:"trial",subscription_status:"trialing",trial_ends_at:new Date(Date.now()+14*86400_000).toISOString(),limits:{users:3,products:500,customers:500,monthly_orders:1000}}).select("id").single();
        if(tenantError)throw tenantError;tenantId=tenant.id;
        const {data:member,error:memberError}=await db.from("wm_tenant_members").insert({tenant_id:tenantId,user_id:userId,email,role:"owner",active:true}).select("id").single();
        if(memberError)throw memberError;
        const {error:settingsError}=await db.from("wm_store_settings").insert({tenant_id:tenantId,store_name:storeName,pix_holder_name:ownerName,whatsapp:phone,store_enabled:true});
        if(settingsError)throw settingsError;
        const token=randomToken();await db.from("wm_sessions").insert({tenant_id:tenantId,user_id:userId,member_id:member.id,role:"owner",token_hash:await sha(token),expires_at:new Date(Date.now()+30*86400_000).toISOString()});
        if(signupAttempt)await db.from("wm_signup_attempts").update({succeeded:true}).eq("id",signupAttempt.id);
        return reply({token,account:{tenantId,storeName,slug,ownerName,role:"owner",storeUrl:`/loja?loja=${slug}`}},201);
      }catch(error){if(tenantId)await db.from("wm_tenants").delete().eq("id",tenantId);await db.auth.admin.deleteUser(userId);throw error}
    }
    if (action === "email_login") {
      const email=String(body.email||"").trim().toLowerCase(),password=String(body.password||"");
      const loginKey=await sha((req.headers.get("cf-connecting-ip")||req.headers.get("x-forwarded-for")||"unknown")+"|email|"+(req.headers.get("user-agent")||""));
      const loginSince=new Date(Date.now()-15*60_000).toISOString();
      const {count:loginCount}=await db.from("wm_login_attempts").select("*",{count:"exact",head:true}).eq("client_key",loginKey).eq("succeeded",false).gte("attempted_at",loginSince);
      if((loginCount||0)>=5)return reply({error:"Muitas tentativas. Aguarde 15 minutos."},429);
      const {data:auth,error:authError}=await authClient.auth.signInWithPassword({email,password});
      await db.from("wm_login_attempts").insert({client_key:loginKey,succeeded:!authError&&!!auth.user});
      if(authError||!auth.user)return reply({error:"E-mail ou senha incorretos."},401);
      const {data:member,error:memberError}=await db.from("wm_tenant_members").select("id,tenant_id,role,wm_tenants!inner(name,slug,active,subscription_status,trial_ends_at,grace_until,subscription_due_at)").eq("user_id",auth.user.id).eq("active",true).eq("wm_tenants.active",true).limit(1).maybeSingle();
      if(memberError)throw memberError;if(!member)return reply({error:"Sua conta não está vinculada a uma loja ativa."},403);
      if(!tenantCanOperate(member.wm_tenants))return reply({error:"Acesso temporariamente bloqueado. Entre em contato para regularizar sua mensalidade.",code:"SUBSCRIPTION_BLOCKED",whatsapp:"5591984855557",subscription:{status:member.wm_tenants?.subscription_status,dueAt:member.wm_tenants?.subscription_due_at}},402);
      const token=randomToken();await db.from("wm_sessions").insert({tenant_id:member.tenant_id,user_id:auth.user.id,member_id:member.id,role:member.role,token_hash:await sha(token),expires_at:new Date(Date.now()+30*86400_000).toISOString()});
      return reply({token,account:{tenantId:member.tenant_id,storeName:member.wm_tenants?.name,slug:member.wm_tenants?.slug,role:member.role,storeUrl:`/loja?loja=${member.wm_tenants?.slug}`}});
    }
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
    const sessionTenantId = session.tenantId;
    const sessionRole=session.role||"owner";
    if(!canRun(sessionRole,action))return reply({error:"Seu perfil não tem permissão para realizar esta ação."},403);
    const wmTenantId=await getWmTenantId();
    const platformAdmin=sessionTenantId===wmTenantId&&(sessionRole==="owner"||sessionRole==="admin");
    const {data:billingTenant,error:billingError}=await db.from("wm_tenants").select("name,slug,owner_name,subscription_status,trial_ends_at,subscription_due_at,grace_until,monthly_price,business_activity,business_segment").eq("id",sessionTenantId).single();
    if(billingError)throw billingError;
    if(!platformAdmin&&!tenantCanOperate(billingTenant))return reply({error:"Acesso temporariamente bloqueado. Regularize sua mensalidade para continuar.",code:"SUBSCRIPTION_BLOCKED",whatsapp:"5591984855557",subscription:{status:billingTenant.subscription_status,dueAt:billingTenant.subscription_due_at}},402);
    if (action === "session_check") {
      return reply({authenticated:true,account:{tenantId:sessionTenantId,storeName:billingTenant?.name||"WM Vendas",slug:billingTenant?.slug||"wm-vendas",ownerName:billingTenant?.owner_name||"",role:session.role||"owner",businessActivity:billingTenant.business_activity,businessSegment:billingTenant.business_segment,hasIndividualLogin:!!session.userId,isPlatformAdmin:platformAdmin,subscription:{status:billingTenant.subscription_status,dueAt:billingTenant.subscription_due_at,graceUntil:billingTenant.grace_until,monthlyPrice:Number(billingTenant.monthly_price||0)},storeUrl:`/loja?loja=${billingTenant?.slug||"wm-vendas"}`}});
    }
    if(action==="platform_list_tenants"){
      if(!platformAdmin)return reply({error:"Acesso exclusivo da administração WM Vendas."},403);
      const {data:tenants,error}=await db.from("wm_tenants").select("id,slug,name,owner_name,owner_phone,plan_code,subscription_status,trial_ends_at,subscription_due_at,grace_until,monthly_price,billing_notes,active,created_at,business_activity,business_segment,wm_tenant_members(email,active)").order("created_at",{ascending:false});
      if(error)throw error;
      return reply({tenants:(tenants||[]).map((tenant:any)=>({...tenant,monthlyPrice:Number(tenant.monthly_price||0),ownerEmail:(tenant.wm_tenant_members||[]).find((member:any)=>member.active)?.email||""}))});
    }
    if(action==="platform_create_tenant"){
      if(!platformAdmin)return reply({error:"Acesso exclusivo da administração WM Vendas."},403);
      const email=String(body.email||"").trim().toLowerCase(),password=String(body.password||""),ownerName=String(body.ownerName||"").trim(),storeName=String(body.storeName||"").trim(),phone=String(body.phone||"").trim(),monthlyPrice=Math.max(0,Number(body.monthlyPrice||0)),dueAt=String(body.dueAt||"")||null,planCode=String(body.planCode||"essencial").slice(0,30);
      const profile=businessProfile(body.businessActivity,body.businessSegment);if(!profile)return reply({error:"Escolha uma atividade e um segmento compatíveis."},400);
      if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||password.length<8||ownerName.length<2||storeName.length<2)return reply({error:"Informe loja, responsável, e-mail válido e senha com pelo menos 8 caracteres."},400);
      let slug=tenantSlug(String(body.slug||storeName));if(slug.length<3)return reply({error:"O endereço da loja precisa ter pelo menos 3 caracteres."},400);
      const {data:existing}=await db.from("wm_tenants").select("id").eq("slug",slug).maybeSingle();if(existing)slug=`${slug}-${crypto.randomUUID().slice(0,5)}`;
      const {data:created,error:createError}=await db.auth.admin.createUser({email,password,email_confirm:true,user_metadata:{name:ownerName}});if(createError)return reply({error:createError.message.includes("already")?"Este e-mail já possui uma conta.":"Não foi possível criar o acesso."},400);
      const userId=created.user?.id;if(!userId)return reply({error:"Não foi possível criar o acesso."},500);let tenantId="";
      try{
        const graceUntil=dueAt?new Date(new Date(dueAt+"T23:59:59Z").getTime()+3*86400_000).toISOString():null;
        const {data:tenant,error:tenantError}=await db.from("wm_tenants").insert({slug,name:storeName,owner_name:ownerName,owner_phone:phone,business_activity:profile.activity,business_segment:profile.segment,plan_code:planCode,subscription_status:"active",monthly_price:monthlyPrice,subscription_due_at:dueAt?dueAt+"T23:59:59Z":null,grace_until:graceUntil,limits:{users:5,products:500,customers:500,monthly_orders:1000}}).select("id").single();if(tenantError)throw tenantError;tenantId=tenant.id;
        const {data:member,error:memberError}=await db.from("wm_tenant_members").insert({tenant_id:tenantId,user_id:userId,name:ownerName,email,role:"owner",active:true}).select("id").single();if(memberError)throw memberError;
        const {error:settingsError}=await db.from("wm_store_settings").insert({tenant_id:tenantId,store_name:storeName,pix_holder_name:ownerName,whatsapp:phone,store_enabled:true});if(settingsError)throw settingsError;
        await audit(session,"platform.tenant_created","tenant",tenantId,{email,storeName,monthlyPrice,dueAt});
        return reply({message:"Lojista criado com acesso liberado.",tenant:{id:tenantId,slug,email,storeUrl:`/loja?loja=${slug}`}},201);
      }catch(error){if(tenantId)await db.from("wm_tenants").delete().eq("id",tenantId);await db.auth.admin.deleteUser(userId);throw error}
    }
    if(action==="platform_update_tenant"){
      if(!platformAdmin)return reply({error:"Acesso exclusivo da administração WM Vendas."},403);
      const id=String(body.id||""),status=String(body.status||"");if(!id||!["trialing","active","past_due","suspended","cancelled"].includes(status))return reply({error:"Loja ou situação inválida."},400);if(id===wmTenantId&&status!=="active")return reply({error:"A loja principal WM Vendas não pode ser bloqueada."},400);
      const profile=businessProfile(body.businessActivity,body.businessSegment);if(!profile)return reply({error:"Escolha uma atividade e um segmento compatíveis."},400);
      const dueAt=String(body.dueAt||"")||null,graceDays=Math.max(0,Math.min(30,Number(body.graceDays||3))),monthlyPrice=Math.max(0,Number(body.monthlyPrice||0));
      const graceUntil=dueAt?new Date(new Date(dueAt+"T23:59:59Z").getTime()+graceDays*86400_000).toISOString():null;
      const {error}=await db.from("wm_tenants").update({business_activity:profile.activity,business_segment:profile.segment,plan_code:String(body.planCode||"essencial").slice(0,30),subscription_status:status,monthly_price:monthlyPrice,subscription_due_at:dueAt?dueAt+"T23:59:59Z":null,grace_until:graceUntil,blocked_at:["suspended","cancelled"].includes(status)?new Date().toISOString():null,billing_notes:String(body.notes||"").slice(0,500),updated_at:new Date().toISOString()}).eq("id",id);if(error)throw error;
      if(["suspended","cancelled"].includes(status))await db.from("wm_sessions").delete().eq("tenant_id",id);
      await audit(session,"platform.subscription_updated","tenant",id,{status,monthlyPrice,dueAt,graceDays});
      return reply({message:status==="active"?"Acesso liberado com sucesso.":status==="past_due"?"Loja marcada como pagamento pendente.":"Acesso da loja atualizado."});
    }
    if(action==="team_list"){
      const [{data:tenant,error:tenantError},{data:members,error},{data:sessions,error:sessionsError},{data:events,error:eventsError}]=await Promise.all([
        db.from("wm_tenants").select("limits").eq("id",sessionTenantId).single(),
        db.from("wm_tenant_members").select("id,user_id,name,email,role,active,created_at,updated_at").eq("tenant_id",sessionTenantId).order("created_at"),
        db.from("wm_sessions").select("member_id,last_seen_at,created_at").eq("tenant_id",sessionTenantId).not("member_id","is",null).order("last_seen_at",{ascending:false}).limit(100),
        db.from("wm_audit_events").select("id,event_type,entity_type,entity_id,metadata,created_at").eq("tenant_id",sessionTenantId).order("created_at",{ascending:false}).limit(20)
      ]);
      if(error)throw error;if(tenantError)throw tenantError;if(sessionsError)throw sessionsError;if(eventsError)throw eventsError;
      const lastSeen=new Map<string,string>();for(const item of sessions||[]){if(item.member_id&&!lastSeen.has(item.member_id))lastSeen.set(item.member_id,item.last_seen_at||item.created_at)}
      return reply({members:(members||[]).map((m:any)=>({id:m.id,name:m.name||m.email||"Usuário",email:m.email||"",role:m.role,active:m.active,createdAt:m.created_at,updatedAt:m.updated_at,lastSeenAt:lastSeen.get(m.id)||null,current:m.id===session.memberId})),events:(events||[]).map((e:any)=>({id:e.id,type:e.event_type,entityType:e.entity_type,entityId:e.entity_id,createdAt:e.created_at,actorEmail:e.metadata?.email||null})),limit:Number(tenant.limits?.users||5),hasIndividualLogin:!!session.userId});
    }
    if(action==="create_team_member"){
      const name=String(body.name||"").trim(),email=String(body.email||"").trim().toLowerCase(),password=String(body.password||""),role=String(body.role||"seller");
      if(name.length<2||!/^\S+@\S+\.\S+$/.test(email)||password.length<8||!["admin","seller","viewer"].includes(role))return reply({error:"Informe nome, e-mail, senha com 8 caracteres e perfil válido."},400);
      if(sessionRole!=="owner"&&role==="admin")return reply({error:"Somente o proprietário pode criar administradores."},403);
      const [{count},{data:tenant,error:tenantError}]=await Promise.all([db.from("wm_tenant_members").select("*",{count:"exact",head:true}).eq("tenant_id",sessionTenantId).eq("active",true),db.from("wm_tenants").select("limits").eq("id",sessionTenantId).single()]);
      if(tenantError)throw tenantError;const limit=Number(tenant.limits?.users||5);if((count||0)>=limit)return reply({error:`Limite de ${limit} usuários ativos atingido.`},409);
      const existing=await db.from("wm_tenant_members").select("id").eq("tenant_id",sessionTenantId).eq("email",email).maybeSingle();
      if(existing.data)return reply({error:"Este e-mail já pertence à equipe."},409);
      const {data:created,error:authError}=await db.auth.admin.createUser({email,password,email_confirm:true,user_metadata:{name}});
      if(authError||!created.user)return reply({error:authError?.message||"Não foi possível criar o acesso."},400);
      const {data:member,error}=await db.from("wm_tenant_members").insert({tenant_id:sessionTenantId,user_id:created.user.id,name,email,role,active:true,created_by:session.memberId}).select("id").single();
      if(error){await db.auth.admin.deleteUser(created.user.id);throw error}
      await audit(session,"team.member_created","tenant_member",member.id,{name,email,role});
      return reply({message:"Usuário criado. Ele já pode entrar com e-mail e senha."},201);
    }
    if(action==="update_team_member"){
      const id=String(body.id||""),role=String(body.role||"seller"),active=body.active!==false;
      if(!id||!["admin","seller","viewer"].includes(role))return reply({error:"Usuário ou perfil inválido."},400);
      if(id===session.memberId&&!active)return reply({error:"Você não pode bloquear o próprio acesso."},400);
      const {data:target,error:findError}=await db.from("wm_tenant_members").select("id,user_id,role,email").eq("tenant_id",sessionTenantId).eq("id",id).maybeSingle();
      if(findError)throw findError;if(!target)return reply({error:"Usuário não encontrado."},404);
      if(target.role==="owner")return reply({error:"O proprietário não pode ser alterado."},403);
      if(sessionRole!=="owner"&&(target.role==="admin"||role==="admin"))return reply({error:"Somente o proprietário pode alterar administradores."},403);
      const {error}=await db.from("wm_tenant_members").update({role,active,updated_at:new Date().toISOString()}).eq("tenant_id",sessionTenantId).eq("id",id);if(error)throw error;
      await db.from("wm_sessions").update({role}).eq("tenant_id",sessionTenantId).eq("member_id",id);
      if(!active)await db.from("wm_sessions").delete().eq("tenant_id",sessionTenantId).eq("member_id",id);
      await audit(session,"team.member_updated","tenant_member",id,{email:target.email,role,active});
      return reply({message:active?"Permissões atualizadas.":"Usuário bloqueado e sessões encerradas."});
    }
    if(action==="change_password"){
      const password=String(body.password||"");if(!session.userId)return reply({error:"Contas com PIN não possuem senha individual."},400);if(password.length<8)return reply({error:"A nova senha precisa ter pelo menos 8 caracteres."},400);
      const {error}=await db.auth.admin.updateUserById(session.userId,{password});if(error)throw error;await audit(session,"account.password_changed","user",session.userId);return reply({message:"Senha alterada com segurança."});
    }
    if (action === "barcode_lookup") {
      const barcode=String(body.barcode||"").trim();
      if(!/^[A-Za-z0-9._-]{4,40}$/.test(barcode))return reply({error:"Código de barras inválido."},400);
      const tenantId=sessionTenantId;
      const {data:owned,error:ownedError}=await db.from("wm_products").select("id,name,brand,cost_price,sale_price,stock,photo_path,catalog_image_url").eq("tenant_id",tenantId).eq("barcode",barcode).maybeSingle();
      if(ownedError)throw ownedError;
      if(owned){
        let imageUrl=null;
        if(owned.photo_path)imageUrl=(await db.storage.from("wm-product-images").createSignedUrl(owned.photo_path,3600)).data?.signedUrl||null;
        return reply({found:true,registered:true,product:{id:owned.id,barcode,name:owned.name,brand:owned.brand,costPrice:Number(owned.cost_price),salePrice:Number(owned.sale_price),stock:Number(owned.stock),category:"Outros",imageUrl:imageUrl||owned.catalog_image_url||null,source:"Estoque da loja"}});
      }
      const {data:catalog,error:catalogError}=await db.from("wm_product_catalog").select("barcode,name,brand,category,image_url,source").eq("barcode",barcode).maybeSingle();
      if(catalogError)throw catalogError;
      if(!catalog)return reply({found:false});
      return reply({found:true,product:{barcode:catalog.barcode,name:catalog.name,brand:catalog.brand,category:catalog.category,imageUrl:catalog.image_url,source:catalog.source}});
    }
    if (action === "finance_report") {
      const tenantId = sessionTenantId;
      const requestedStart = String(body.startDate || "");
      const startDate = /^\d{4}-\d{2}-\d{2}$/.test(requestedStart) ? requestedStart : new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString().slice(0,10);
      const [cash, sales, paidReceivables, pendingReceivables, paidBills] = await Promise.all([
        db.from("wm_cash_entries").select("id,kind,category,description,amount,payment_method,occurred_at").eq("tenant_id",tenantId).gte("occurred_at",startDate).limit(200),
        db.from("wm_sales").select("id,receipt_code,customer_id,quantity,total,discount,cost_total,payment_method,installments,sold_at,wm_products(name,sale_price),wm_customers(name,phone)").eq("tenant_id",tenantId).gte("sold_at",startDate),
        db.from("wm_receivables").select("id,sale_id,amount,due_date,paid_at,status,installment_number,wm_customers(name)").eq("tenant_id",tenantId).eq("status","paid").gte("paid_at",startDate),
        db.from("wm_receivables").select("id,sale_id,amount,due_date,paid_at,status,installment_number,wm_customers(name)").eq("tenant_id",tenantId).eq("status","pending").order("due_date"),
        db.from("wm_supplier_bills").select("id,amount,paid_at,supplier_name").eq("tenant_id",tenantId).eq("status","paid").gte("paid_at",startDate)
      ]);
      for (const result of [cash,sales,paidReceivables,pendingReceivables,paidBills]) if (result.error) throw result.error;
      const manual = cash.data || [], saleRows = sales.data || [], paidRows = paidReceivables.data || [], pendingRows = pendingReceivables.data || [], billRows = paidBills.data || [];
      const instantRows = saleRows.filter((sale:any)=>sale.payment_method!=="parcelado");
      const instantSales = instantRows.reduce((sum:number,sale:any)=>sum+Number(sale.total),0), installmentReceipts = paidRows.reduce((sum:number,item:any)=>sum+Number(item.amount),0), outstanding = pendingRows.reduce((sum:number,item:any)=>sum+Number(item.amount),0);
      const manualIncome = manual.filter((item:any)=>item.kind==="income").reduce((sum:number,item:any)=>sum+Number(item.amount),0), manualExpense = manual.filter((item:any)=>item.kind==="expense").reduce((sum:number,item:any)=>sum+Number(item.amount),0), supplierExpense = billRows.reduce((sum:number,item:any)=>sum+Number(item.amount),0);
      const totalSales = saleRows.reduce((sum:number,sale:any)=>sum+Number(sale.total),0), costOfGoods = saleRows.reduce((sum:number,sale:any)=>sum+Number(sale.cost_total),0), income = instantSales + installmentReceipts + manualIncome, expenses = manualExpense + supplierExpense;
      const movements = [...manual.map((item:any)=>({id:`manual-${item.id}`,kind:item.kind,category:item.category,description:item.description,amount:Number(item.amount),paymentMethod:item.payment_method,occurredAt:item.occurred_at})),...instantRows.map((sale:any)=>({id:`sale-${sale.id}`,kind:"income",category:"Venda",description:sale.wm_products?.name||"Venda à vista",amount:Number(sale.total),paymentMethod:sale.payment_method,occurredAt:sale.sold_at})),...paidRows.map((item:any)=>({id:`received-${item.id}`,kind:"income",category:"Parcela recebida",description:`${item.wm_customers?.name||"Cliente"} - parcela ${item.installment_number}`,amount:Number(item.amount),paymentMethod:"recebimento",occurredAt:item.paid_at})),...pendingRows.map((item:any)=>({id:`pending-${item.id}`,kind:"pending",category:"A receber",description:`${item.wm_customers?.name||"Cliente"} - parcela ${item.installment_number}`,amount:Number(item.amount),paymentMethod:"parcelado",occurredAt:`${item.due_date}T12:00:00Z`})),...billRows.map((item:any)=>({id:`bill-${item.id}`,kind:"expense",category:"Fornecedor",description:item.supplier_name||"Boleto pago",amount:Number(item.amount),paymentMethod:"boleto",occurredAt:item.paid_at}))].sort((a:any,b:any)=>new Date(b.occurredAt).getTime()-new Date(a.occurredAt).getTime()).slice(0,200);
      const receiptMap = new Map<string,any>();
      for (const sale of saleRows as any[]) {
        const code = String(sale.receipt_code || `sale-${sale.id}`);
        if (!receiptMap.has(code)) receiptMap.set(code,{receiptCode:code,firstSaleId:Number(sale.id),customerName:sale.wm_customers?.name||"Cliente avulso",customerPhone:sale.wm_customers?.phone||"",subtotal:0,discount:0,total:0,paymentMethod:sale.payment_method||"",installments:Number(sale.installments||1),soldAt:sale.sold_at,items:[],installmentDates:[]});
        const receipt=receiptMap.get(code),quantity=Number(sale.quantity||1),lineTotal=Number(sale.total||0),discount=Number(sale.discount||0),unitPrice=Number(sale.wm_products?.sale_price||0);
        receipt.firstSaleId=Math.min(receipt.firstSaleId,Number(sale.id));receipt.subtotal+=unitPrice*quantity;receipt.discount+=discount;receipt.total+=lineTotal;
        receipt.items.push({name:sale.wm_products?.name||"Produto",quantity,unitPrice,lineTotal});
      }
      const receivableRows=[...paidRows,...pendingRows];
      for (const receipt of receiptMap.values()) receipt.installmentDates=receivableRows.filter((item:any)=>Number(item.sale_id)===receipt.firstSaleId).map((item:any)=>({number:Number(item.installment_number),dueDate:item.due_date,amount:Number(item.amount),status:item.status})).sort((a:any,b:any)=>a.number-b.number);
      const receipts=Array.from(receiptMap.values()).map(({firstSaleId,...receipt})=>receipt).sort((a:any,b:any)=>new Date(b.soldAt).getTime()-new Date(a.soldAt).getTime());
      return reply({startDate,summary:{income,expenses,balance:income-expenses,sales:totalSales,outstanding,costOfGoods,estimatedProfit:totalSales-costOfGoods-manualExpense},entries:movements,receipts});
    }
    if (action === "create_cash_entry") {
      const tenantId = sessionTenantId;
      const kind = String(body.kind||"expense"), description = String(body.description||"").trim(), amount = Number(body.amount);
      if (!["income","expense"].includes(kind)||description.length<2||!Number.isFinite(amount)||amount<=0) return reply({error:"Informe tipo, descrição e valor válidos."},400);
      const { error } = await db.from("wm_cash_entries").insert({tenant_id:tenantId,kind,category:String(body.category||"Outros").slice(0,60),description:description.slice(0,160),amount,payment_method:String(body.paymentMethod||"other").slice(0,30),occurred_at:String(body.occurredAt||new Date().toISOString())});
      if (error) throw error;
      return reply({message:kind==="expense"?"Despesa registrada.":"Entrada registrada."},201);
    }
    if (action === "store_admin") {
      const tenantId = sessionTenantId;
      const { error: expireError } = await db.rpc("wm_expire_store_reservations", { p_tenant_id: tenantId });
      if (expireError) throw expireError;
      const [{ data: settings, error: settingsError }, { data: orders, error: ordersError },{data:tenant,error:tenantError}] = await Promise.all([
        db.from("wm_store_settings").select("*").eq("tenant_id", tenantId).maybeSingle(),
        db.from("wm_store_orders").select("id,public_id,customer_name,phone,delivery_type,address,total,status,payment_method,reservation_expires_at,pix_payload,paid_at,created_at,wm_store_order_items(product_name,unit_price,quantity,line_total)").eq("tenant_id", tenantId).order("created_at", { ascending: false }).limit(100),
        db.from("wm_tenants").select("slug").eq("id",tenantId).single()
      ]);
      if (settingsError) throw settingsError;
      if (ordersError) throw ordersError;
      if (tenantError) throw tenantError;
      const logoUrl=settings.logo_path?(await db.storage.from("wm-store-assets").createSignedUrl(settings.logo_path,3600)).data?.signedUrl||null:settings.logo_url||null;
      return reply({
        settings: {
          slug:tenant.slug,
          storeName: settings.store_name,
          pixKey: settings.pix_key,
          pixHolderName: settings.pix_holder_name,
          pixCity: settings.pix_city,
          whatsapp: settings.whatsapp,
          storeEnabled: settings.store_enabled,
          logoUrl,
          primaryColor:settings.primary_color,
          accentColor:settings.accent_color,
          slogan:settings.slogan
        },
        orders: (orders || []).map((o: any) => ({
          id: o.id,
          publicId: o.public_id,
          customerName: o.customer_name,
          phone: o.phone,
          deliveryType: o.delivery_type,
          address: o.address,
          total: Number(o.total),
          status: o.status,
          paymentMethod: o.payment_method,
          reservationExpiresAt: o.reservation_expires_at,
          pixPayload: o.pix_payload,
          paidAt: o.paid_at,
          createdAt: o.created_at,
          items: (o.wm_store_order_items || []).map((i: any) => ({ name: i.product_name, unitPrice: Number(i.unit_price), quantity: i.quantity, lineTotal: Number(i.line_total) }))
        }))
      });
    }
    if (action === "update_store_settings") {
      const storeName = String(body.storeName || "WM Vendas").trim();
      const pixKey = String(body.pixKey || "").trim();
      const pixHolderName = String(body.pixHolderName || "Walquiria Maia").trim();
      const pixCity = String(body.pixCity || "SAO PAULO").trim();
      const whatsapp = String(body.whatsapp || "").replace(/\D/g, "");
      const primaryColor=/^#[0-9a-f]{6}$/i.test(String(body.primaryColor||""))?String(body.primaryColor):"#7b2448";
      const accentColor=/^#[0-9a-f]{6}$/i.test(String(body.accentColor||""))?String(body.accentColor):"#d6ad60";
      if (!storeName || !pixHolderName || !pixCity) return reply({ error: "Preencha os dados da loja e do titular do PIX." }, 400);
      const {data:current,error:currentError}=await db.from("wm_store_settings").select("logo_path").eq("tenant_id",sessionTenantId).eq("id",true).maybeSingle();
      if(currentError)throw currentError;
      let logoPath=current?.logo_path as string|null,newLogoPath:string|null=null;
      const logo=String(body.logo||"");
      if(logo){
        const match=logo.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
        if(!match)return reply({error:"Formato de logomarca inválido. Use JPG, PNG ou WebP."},400);
        const bytes=Uint8Array.from(atob(match[2]),c=>c.charCodeAt(0));
        if(bytes.byteLength>1024*1024)return reply({error:"A logomarca deve ter no máximo 1 MB."},400);
        const ext=match[1]==="image/png"?"png":match[1]==="image/webp"?"webp":"jpg";
        newLogoPath=`${sessionTenantId}/logo-${crypto.randomUUID()}.${ext}`;
        const {error:uploadError}=await db.storage.from("wm-store-assets").upload(newLogoPath,bytes,{contentType:match[1],cacheControl:"3600",upsert:false});
        if(uploadError)throw uploadError;logoPath=newLogoPath;
      }else if(body.removeLogo===true){logoPath=null}
      const { error } = await db.from("wm_store_settings").update({
        store_name: storeName,
        pix_key: pixKey,
        pix_holder_name: pixHolderName,
        pix_city: pixCity,
        whatsapp,
        logo_path:logoPath,
        primary_color:primaryColor,
        accent_color:accentColor,
        slogan:String(body.slogan||"Estoque, vendas e cobranças na palma da mão").slice(0,120),
        store_enabled: body.storeEnabled !== false,
        updated_at: new Date().toISOString()
      }).eq("tenant_id", sessionTenantId).eq("id", true);
      if (error){if(newLogoPath)await db.storage.from("wm-store-assets").remove([newLogoPath]);throw error}
      if(current?.logo_path&&current.logo_path!==logoPath)await db.storage.from("wm-store-assets").remove([current.logo_path]);
      await audit(session,"store.brand_updated","store_settings",sessionTenantId,{logoChanged:!!logo||body.removeLogo===true});
      return reply({ message: "Configurações da loja atualizadas." });
    }
    if (action === "update_store_order_status") {
      const id = Number(body.id);
      const status = String(body.status || "");
      if (!Number.isInteger(id) || !["reserved","paid","preparing","completed","cancelled"].includes(status)) return reply({ error: "Pedido ou status inválido." }, 400);
      if (status === "cancelled") {
        const { error: cancelError } = await db.rpc("wm_cancel_store_order", { p_order_id: id });
        if (cancelError) return reply({ error: cancelError.message }, 400);
        return reply({ message: "Pedido cancelado e estoque devolvido." });
      }
      const changes: Record<string, unknown> = { status, updated_at: new Date().toISOString() };
      if (status === "paid") changes.paid_at = new Date().toISOString();
      const { error } = await db.from("wm_store_orders").update(changes).eq("tenant_id", sessionTenantId).eq("id", id);
      if (error) throw error;
      return reply({ message: status === "paid" ? "Pagamento confirmado." : "Pedido atualizado." });
    }
    if (action === "logout") {
      await db.from("wm_sessions").delete().eq("id", session.id);
      return reply({ success: true });
    }
    if (action === "list") {
      const [pr, cr, rr, sr, ar, br, tr] = await Promise.all([
        db.from("wm_products").select("*").eq("tenant_id",sessionTenantId).order("id", { ascending: false }),
        db.from("wm_customers").select("*").eq("tenant_id",sessionTenantId).order("name"),
        db.from("wm_receivables").select("id,amount,due_date,status,installment_number,wm_customers(name,phone)").eq("tenant_id",sessionTenantId).eq("status", "pending").order("due_date"),
        db.from("wm_sales").select("customer_id,total,cost_total").eq("tenant_id",sessionTenantId),
        db.from("wm_receivables").select("customer_id,amount,due_date,status,paid_at").eq("tenant_id",sessionTenantId),
        db.from("wm_supplier_bills").select("id,supplier_name,description,amount,due_date,barcode_line,status").eq("tenant_id",sessionTenantId).order("due_date"),
        db.from("wm_tenants").select("name,slug,owner_name,subscription_status,subscription_due_at,grace_until,monthly_price").eq("id",sessionTenantId).single()
      ]);
      for (const result of [pr, cr, rr, sr, ar, br, tr]) if (result.error) throw result.error;
      const products = pr.data || [], sales = sr.data || [], today = new Date().toISOString().slice(0, 10);
      const charges = (rr.data || []).map((r: any) => ({ id:r.id, amount:Number(r.amount), dueDate:r.due_date, status:r.due_date<today?"overdue":"upcoming", installmentNumber:r.installment_number, customerName:r.wm_customers?.name||"Cliente", phone:r.wm_customers?.phone||"" }));
      const investment = products.reduce((sum:number,p:any)=>sum+Number(p.cost_price)*p.stock,0);
      const expectedRevenue = products.reduce((sum:number,p:any)=>sum+Number(p.sale_price)*p.stock,0);
      const pending = charges.reduce((sum:number,r:any)=>sum+r.amount,0);
      const todayDate=new Date(`${today}T12:00:00Z`);
      const supplierBills=(br.data||[]).map((b:any)=>{const daysUntilDue=Math.round((new Date(`${b.due_date}T12:00:00Z`).getTime()-todayDate.getTime())/86400000);const status=b.status==="paid"?"paid":daysUntilDue<0?"overdue":daysUntilDue===0?"today":daysUntilDue<=3?"dueSoon":"upcoming";return {id:b.id,supplierName:b.supplier_name,description:b.description,amount:Number(b.amount),dueDate:b.due_date,barcodeLine:b.barcode_line,status,daysUntilDue}});
      const pendingSupplierBills=supplierBills.filter((b:any)=>b.status!=="paid");
      const customerStats = new Map<number,{totalPurchased:number;purchaseCount:number;pendingBalance:number;overdueCount:number;latePayments:number}>();
      const statsFor=(id:number)=>{if(!customerStats.has(id))customerStats.set(id,{totalPurchased:0,purchaseCount:0,pendingBalance:0,overdueCount:0,latePayments:0});return customerStats.get(id)!};
      for(const sale of sales){if(sale.customer_id){const stat=statsFor(sale.customer_id);stat.totalPurchased+=Number(sale.total);stat.purchaseCount+=1}}
      for(const item of ar.data||[]){if(!item.customer_id)continue;const stat=statsFor(item.customer_id);if(item.status==="pending"){stat.pendingBalance+=Number(item.amount);if(item.due_date<today)stat.overdueCount+=1}else if(item.status==="paid"&&item.paid_at&&item.paid_at.slice(0,10)>item.due_date){stat.latePayments+=1}}
      const photoPaths=products.map((p:any)=>p.photo_path).filter(Boolean);
      const signedByPath=new Map<string,string>();
      if(photoPaths.length){
        const {data:signedPhotos,error:signedError}=await db.storage.from("wm-product-images").createSignedUrls(photoPaths,3600);
        if(!signedError) for(const item of signedPhotos||[]) if(item.path&&item.signedUrl)signedByPath.set(item.path,item.signedUrl);
      }
      return reply({
        account:{tenantId:sessionTenantId,storeName:tr.data?.name||"WM Vendas",slug:tr.data?.slug||"wm-vendas",ownerName:tr.data?.owner_name||"",role:session.role||"owner",hasIndividualLogin:!!session.userId,isPlatformAdmin:platformAdmin,subscription:{status:tr.data?.subscription_status,dueAt:tr.data?.subscription_due_at,graceUntil:tr.data?.grace_until,monthlyPrice:Number(tr.data?.monthly_price||0)},storeUrl:`/loja?loja=${tr.data?.slug||"wm-vendas"}`},
        products:products.map((p:any)=>({id:p.id,barcode:p.barcode,name:p.name,brand:p.brand,costPrice:Number(p.cost_price),salePrice:Number(p.sale_price),stock:p.stock,photoUrl:p.photo_path?signedByPath.get(p.photo_path)||null:p.catalog_image_url||null})),
        customers:(cr.data||[]).map((c:any)=>{const stat=statsFor(c.id);const loyaltyLevel=stat.totalPurchased>=3000?"Diamante":stat.totalPurchased>=1500?"Ouro":stat.totalPurchased>=500?"Prata":stat.totalPurchased>0?"Bronze":"Novo";const paymentStatus=stat.purchaseCount===0?"Novo":stat.overdueCount>0?"Em atraso":stat.latePayments>0?"Atenção":"Em dia";return {id:c.id,name:c.name,phone:c.phone,...stat,loyaltyLevel,paymentStatus}}),
        charges,
        supplierBills,
        dashboard:{investment,expectedRevenue,expectedProfit:expectedRevenue-investment,salesTotal:sales.reduce((s:number,x:any)=>s+Number(x.total),0),received:0,pending,overdueCount:charges.filter((c:any)=>c.status==="overdue").length,supplierPendingTotal:pendingSupplierBills.reduce((s:number,b:any)=>s+b.amount,0),supplierDueSoonCount:pendingSupplierBills.filter((b:any)=>["today","dueSoon"].includes(b.status)).length,supplierOverdueCount:pendingSupplierBills.filter((b:any)=>b.status==="overdue").length}
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
      const { error }=await db.from("wm_products").insert({tenant_id:sessionTenantId,barcode,name,brand:String(body.brand||"Outros"),cost_price:Number(body.costPrice||0),sale_price:Number(body.salePrice||0),stock:Math.max(0,Number(body.stock||0)),photo_path:photoPath,catalog_image_url:String(body.catalogImageUrl||"")||null});
      if(error){
        if(photoPath)await db.storage.from("wm-product-images").remove([photoPath]);
        if(error.code==="23505")return reply({error:"Este código já está cadastrado."},409);
        throw error
      }
      await db.from("wm_product_catalog").upsert({barcode,name,brand:String(body.brand||"Outros"),source:"wm_products",verified_at:new Date().toISOString(),updated_at:new Date().toISOString()},{onConflict:"barcode"});
      return reply({message:"Produto cadastrado com sucesso"});
    }
    if (action === "update_product") {
      const id=Number(body.id), barcode=String(body.barcode||"").trim(), name=String(body.name||"").trim();
      if(!Number.isInteger(id)||id<1||!barcode||!name)return reply({error:"Produto inválido. Confira o código e o nome."},400);
      const {data:current,error:findError}=await db.from("wm_products").select("photo_path").eq("tenant_id",sessionTenantId).eq("id",id).maybeSingle();
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
      const {error}=await db.from("wm_products").update({barcode,name,brand:String(body.brand||"Outros"),cost_price:Number(body.costPrice||0),sale_price:Number(body.salePrice||0),stock:Math.max(0,Number(body.stock||0)),photo_path:nextPhotoPath,catalog_image_url:String(body.catalogImageUrl||"")||null}).eq("tenant_id",sessionTenantId).eq("id",id);
      if(error){
        if(uploadedPhotoPath)await db.storage.from("wm-product-images").remove([uploadedPhotoPath]);
        if(error.code==="23505")return reply({error:"Este código já está cadastrado em outro produto."},409);
        throw error
      }
      if(oldPhotoPath&&oldPhotoPath!==nextPhotoPath)await db.storage.from("wm-product-images").remove([oldPhotoPath]);
      await db.from("wm_product_catalog").upsert({barcode,name,brand:String(body.brand||"Outros"),source:"wm_products",verified_at:new Date().toISOString(),updated_at:new Date().toISOString()},{onConflict:"barcode"});
      return reply({message:"Produto atualizado com sucesso"});
    }
    if (action === "create_customer") {
      const name=String(body.name||"").trim();if(!name)return reply({error:"Informe o nome da cliente."},400);
      const {error}=await db.from("wm_customers").insert({tenant_id:sessionTenantId,name,phone:String(body.phone||"")});if(error)throw error;
      return reply({message:"Cliente cadastrada com sucesso"});
    }
    if (action === "create_express_sale") {
      const tenantId=sessionTenantId;
      if(!Array.isArray(body.items)||body.items.length<1||body.items.length>30)return reply({error:"Adicione produtos ao carrinho."},400);
      const {data,error}=await db.rpc("wm_register_express_sale",{
        p_tenant_id:tenantId,
        p_customer_id:body.customerId?Number(body.customerId):null,
        p_items:body.items,
        p_payment_method:String(body.paymentMethod||"pix"),
        p_installments:Number(body.installments||1),
        p_due_date:String(body.dueDate||new Date(Date.now()+30*86400_000).toISOString().slice(0,10)),
        p_discount:Number(body.discount||0),
        p_operation_id:String(body.operationId||"")
      });
      if(error)return reply({error:error.message},400);
      return reply({message:"Venda concluída com sucesso",receipt:data});
    }
    if (action === "create_sale") return reply({error:"Use a Venda Expressa para registrar com segurança."},410);
    if (action === "mark_paid") {
      const {error}=await db.from("wm_receivables").update({status:"paid",paid_at:new Date().toISOString()}).eq("tenant_id",sessionTenantId).eq("id",Number(body.id));if(error)throw error;
      return reply({message:"Pagamento confirmado"});
    }
    if (action === "create_supplier_bill") {
      const supplierName=String(body.supplierName||"").trim(),dueDate=String(body.dueDate||""),amount=Number(body.amount);
      if(!supplierName||!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)||!Number.isFinite(amount)||amount<=0)return reply({error:"Informe fornecedor, valor e vencimento válidos."},400);
      const {error}=await db.from("wm_supplier_bills").insert({tenant_id:sessionTenantId,supplier_name:supplierName,description:String(body.description||"").trim(),amount,due_date:dueDate,barcode_line:String(body.barcodeLine||"").replace(/\s/g,"")});if(error)throw error;
      return reply({message:"Boleto cadastrado. O aviso aparecerá 3 dias antes."});
    }
    if (action === "mark_supplier_bill_paid") {
      const id=Number(body.id);if(!Number.isInteger(id)||id<1)return reply({error:"Boleto inválido."},400);
      const {error}=await db.from("wm_supplier_bills").update({status:"paid",paid_at:new Date().toISOString()}).eq("tenant_id",sessionTenantId).eq("id",id);if(error)throw error;
      return reply({message:"Boleto marcado como pago."});
    }
    return reply({ error: "Ação inválida." }, 400);
  } catch (error) {
    console.error(error);
    return reply({ error: "Não foi possível concluir. Tente novamente." }, 500);
  }
});
