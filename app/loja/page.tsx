"use client";

import Image from "next/image";
import Link from "next/link";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { ArrowLeft, Check, ChevronRight, Copy, Loader2, Minus, Plus, Search, ShoppingBag, Store, Trash2, X } from "lucide-react";

type Product = { id:number; name:string; brand:string; price:number; stock:number; photoUrl?:string|null };
type CartItem = Product & { quantity:number };
type Catalog = { store:{ name:string; whatsapp:string; enabled:boolean }; products:Product[] };
type OrderResult = { order:{ id:number; total:number; reference:string }; pix:{ key:string; holder:string; payload:string }; whatsapp:string };

const API_URL = "/api/store";
const money = (value:number) => new Intl.NumberFormat("pt-BR", { style:"currency", currency:"BRL" }).format(value);

async function publicApi(action:string, payload:Record<string,unknown>={}) {
  const response = await fetch(API_URL, { method:"POST", headers:{ "content-type":"application/json" }, body:JSON.stringify({ action, ...payload }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Não foi possível concluir.");
  return result;
}

export default function StorePage() {
  const [catalog,setCatalog]=useState<Catalog|null>(null);
  const [cart,setCart]=useState<CartItem[]>([]);
  const [cartHydrated,setCartHydrated]=useState(false);
  const [search,setSearch]=useState("");
  const [brand,setBrand]=useState("Todas");
  const [cartOpen,setCartOpen]=useState(false);
  const [checkout,setCheckout]=useState(false);
  const [saving,setSaving]=useState(false);
  const [error,setError]=useState("");
  const [order,setOrder]=useState<OrderResult|null>(null);

  useEffect(()=>{publicApi("public_catalog").then(setCatalog).catch(e=>setError(e instanceof Error?e.message:"Não foi possível abrir a loja."))},[]);
  useEffect(()=>{try{const saved=localStorage.getItem("wm_store_cart");if(saved)setCart(JSON.parse(saved))}catch{}finally{setCartHydrated(true)}},[]);
  useEffect(()=>{if(cartHydrated)localStorage.setItem("wm_store_cart",JSON.stringify(cart))},[cart,cartHydrated]);

  const brands=useMemo(()=>["Todas",...Array.from(new Set((catalog?.products||[]).map(p=>p.brand))).sort()],[catalog]);
  const products=useMemo(()=>catalog?.products.filter(p=>(brand==="Todas"||p.brand===brand)&&`${p.name} ${p.brand}`.toLowerCase().includes(search.toLowerCase()))||[],[catalog,brand,search]);
  const count=cart.reduce((sum,item)=>sum+item.quantity,0);
  const total=cart.reduce((sum,item)=>sum+item.price*item.quantity,0);

  function change(product:Product, amount:number){
    setCart(current=>{const existing=current.find(i=>i.id===product.id);const next=Math.max(0,Math.min(product.stock,(existing?.quantity||0)+amount));if(!next)return current.filter(i=>i.id!==product.id);return existing?current.map(i=>i.id===product.id?{...i,quantity:next}:i):[...current,{...product,quantity:next}]});
  }
  async function placeOrder(event:FormEvent<HTMLFormElement>){
    event.preventDefault();setSaving(true);setError("");
    const form=new FormData(event.currentTarget);
    try{
      const result=await publicApi("create_store_order",{customerName:form.get("customerName"),phone:form.get("phone"),deliveryType:form.get("deliveryType"),address:form.get("address"),items:cart.map(i=>({productId:i.id,quantity:i.quantity}))});
      setOrder(result);setCart([]);setCheckout(false);
    }catch(e){setError(e instanceof Error?e.message:"Não foi possível criar o pedido.")}finally{setSaving(false)}
  }
  async function copyPix(){if(order){await navigator.clipboard.writeText(order.pix.payload)}}
  function sendReceipt(){if(!order)return;const phone=order.whatsapp.replace(/\D/g,"");const text=`Olá! Fiz o pedido nº ${order.order.id} na ${catalog?.store.name||"WM Vendas"}, no valor de ${money(order.order.total)}. Referência PIX: ${order.order.reference}.`;window.open(`https://wa.me/${phone}?text=${encodeURIComponent(text)}`,"_blank")}

  if(!catalog&&!error)return <main className="store-loading"><Loader2/><span>Abrindo a loja…</span></main>;
  if(error&&!catalog)return <main className="store-loading"><Store/><h1>Não foi possível abrir a loja</h1><p>{error}</p><button onClick={()=>location.reload()}>Tentar novamente</button></main>;
  if(catalog&&!catalog.store.enabled)return <main className="store-loading"><Store/><h1>Voltamos em breve</h1><p>A loja está temporariamente fechada.</p></main>;

  return <main className="store-page">
    <header className="store-header"><div className="store-brand"><span>WM</span><div><strong>{catalog?.store.name||"WM Vendas"}</strong><small>Walquíria Maia</small></div></div><Link href="/" className="store-admin"><ArrowLeft/> Área da vendedora</Link></header>
    <section className="store-intro"><div><small>BELEZA QUE ENCANTA</small><h1>Escolha seus favoritos</h1><p>Semijoias, perfumes e cosméticos selecionados para você.</p></div><span className="store-sparkle">WM</span></section>
    <section className="store-tools"><label><Search/><input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Buscar produtos…"/></label><div className="brand-pills">{brands.map(item=><button key={item} className={brand===item?"active":""} onClick={()=>setBrand(item)}>{item}</button>)}</div></section>
    <section className="store-grid">{products.map(product=>{const item=cart.find(i=>i.id===product.id);return <article className="store-product" key={product.id}><div className="store-photo">{product.photoUrl?<Image src={product.photoUrl} alt={product.name} fill sizes="(max-width: 640px) 50vw, 260px" unoptimized/>:<ShoppingBag/>}<span>{product.brand}</span></div><div className="store-product-body"><h2>{product.name}</h2><strong>{money(product.price)}</strong><small>{product.stock===1?"Última unidade":`${product.stock} disponíveis`}</small>{item?<div className="quantity"><button onClick={()=>change(product,-1)} aria-label="Diminuir"><Minus/></button><b>{item.quantity}</b><button onClick={()=>change(product,1)} disabled={item.quantity>=product.stock} aria-label="Aumentar"><Plus/></button></div>:<button className="add-cart" onClick={()=>change(product,1)}><Plus/> Adicionar</button>}</div></article>})}</section>
    {!products.length&&<section className="store-empty"><ShoppingBag/><h2>Nenhum produto encontrado</h2><p>Tente outra busca ou categoria.</p></section>}
    {count>0&&<button className="cart-fab" onClick={()=>setCartOpen(true)}><span><ShoppingBag/><i>{count}</i></span><b>Ver sacola</b><strong>{money(total)}</strong></button>}

    {cartOpen&&<div className="store-overlay"><section className="cart-sheet"><header><div><small>SUA SACOLA</small><h2>{count} {count===1?"item":"itens"}</h2></div><button onClick={()=>setCartOpen(false)} aria-label="Fechar"><X/></button></header><div className="cart-list">{cart.map(item=><article key={item.id}><div><b>{item.name}</b><small>{money(item.price)} cada</small></div><div className="quantity"><button onClick={()=>change(item,-1)}><Minus/></button><b>{item.quantity}</b><button onClick={()=>change(item,1)}><Plus/></button></div><strong>{money(item.price*item.quantity)}</strong><button className="remove" onClick={()=>setCart(c=>c.filter(i=>i.id!==item.id))}><Trash2/></button></article>)}</div><footer><div><span>Total</span><strong>{money(total)}</strong></div><button className="checkout-button" onClick={()=>{setCartOpen(false);setCheckout(true)}}>Continuar para pagamento <ChevronRight/></button></footer></section></div>}

    {checkout&&<div className="store-overlay"><section className="checkout-sheet"><header><div><small>FINALIZAR PEDIDO</small><h2>Seus dados</h2></div><button onClick={()=>setCheckout(false)}><X/></button></header><form onSubmit={placeOrder}><label>Nome completo<input name="customerName" required minLength={2} autoFocus/></label><label>WhatsApp<input name="phone" required inputMode="tel" placeholder="(00) 00000-0000"/></label><label>Como deseja receber?<select name="deliveryType" defaultValue="retirada" onChange={e=>{const address=e.currentTarget.form?.elements.namedItem("address") as HTMLInputElement|null;if(address)address.required=e.target.value==="entrega"}}><option value="retirada">Retirar com a vendedora</option><option value="entrega">Receber no endereço</option></select></label><label>Endereço para entrega<input name="address" placeholder="Preencha somente se escolher entrega"/></label>{error&&<p className="store-error">{error}</p>}<div className="checkout-total"><span>Total por PIX</span><strong>{money(total)}</strong></div><button className="checkout-button" disabled={saving}>{saving?<Loader2 className="spin"/>:<ShoppingBag/>} Criar pedido e pagar</button></form></section></div>}

    {order&&<div className="store-overlay"><section className="pix-sheet"><span className="success-mark"><Check/></span><small>PEDIDO Nº {order.order.id}</small><h2>Pedido reservado!</h2><p>Copie o código PIX abaixo e faça o pagamento de <b>{money(order.order.total)}</b>.</p><div className="pix-holder"><small>Recebedor</small><b>{order.pix.holder}</b><span>{order.pix.key}</span></div><button className="copy-pix" onClick={copyPix}><Copy/> Copiar PIX Copia e Cola</button><button className="whatsapp-order" onClick={sendReceipt}>Enviar comprovante pelo WhatsApp</button><button className="close-order" onClick={()=>setOrder(null)}>Continuar na loja</button></section></div>}
  </main>;
}
