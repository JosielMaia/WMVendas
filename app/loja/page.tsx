"use client";

import Image from "next/image";
import Link from "next/link";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { ArrowLeft, Check, ChevronRight, Clock3, Copy, Info, Loader2, Minus, Plus, Search, ShieldCheck, ShoppingBag, Store, Trash2, X } from "lucide-react";

type Product = { id:number; name:string; brand:string; price:number; stock:number; photoUrl?:string|null };
type CartItem = Product & { quantity:number };
type Catalog = { store:{ name:string; whatsapp:string; enabled:boolean }; products:Product[] };
type OrderResult = { order:{ id:number; total:number; reference:string; status:string; paymentMethod:"pix"|"reservation" }; pix:{ key:string; holder:string; payload:string }|null; whatsapp:string };

const API_URL = "/api/store";
const STORE_BRANDS = ["Todas","Rommanel","Natura","O Boticário","Eudora","Avon","Amaggod","Jequiti","Vestuário","Acessórios","Cosméticos","Perfumaria","Outros"];
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
  const [selectedProduct,setSelectedProduct]=useState<Product|null>(null);
  const [paymentMethod,setPaymentMethod]=useState<"pix"|"reservation">("pix");

  useEffect(()=>{publicApi("public_catalog").then(setCatalog).catch(e=>setError(e instanceof Error?e.message:"Não foi possível abrir a loja."))},[]);
  useEffect(()=>{try{const saved=localStorage.getItem("wm_store_cart");if(saved)setCart(JSON.parse(saved))}catch{}finally{setCartHydrated(true)}},[]);
  useEffect(()=>{if(cartHydrated)localStorage.setItem("wm_store_cart",JSON.stringify(cart))},[cart,cartHydrated]);

  const brands=useMemo(()=>Array.from(new Set([...STORE_BRANDS,...(catalog?.products||[]).map(p=>p.brand)])),[catalog]);
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
      const result=await publicApi("create_store_order",{customerName:form.get("customerName"),phone:form.get("phone"),deliveryType:form.get("deliveryType"),address:form.get("address"),paymentMethod,items:cart.map(i=>({productId:i.id,quantity:i.quantity}))});
      setOrder(result);setCart([]);setCheckout(false);
    }catch(e){setError(e instanceof Error?e.message:"Não foi possível criar o pedido.")}finally{setSaving(false)}
  }
  async function copyPix(){if(order?.pix){await navigator.clipboard.writeText(order.pix.payload)}}
  function sendReceipt(){if(!order)return;const phone=order.whatsapp.replace(/\D/g,"");const text=order.order.paymentMethod==="reservation"?`Olá! Solicitei a reserva do pedido nº ${order.order.id} na ${catalog?.store.name||"WM Vendas"}, no valor de ${money(order.order.total)}. Aguardo a confirmação.`:`Olá! Fiz o pedido nº ${order.order.id} na ${catalog?.store.name||"WM Vendas"}, no valor de ${money(order.order.total)}. Referência PIX: ${order.order.reference}.`;window.open(`https://wa.me/${phone}?text=${encodeURIComponent(text)}`,"_blank")}

  if(!catalog&&!error)return <main className="store-loading"><Loader2/><span>Abrindo a loja…</span></main>;
  if(error&&!catalog)return <main className="store-loading"><Store/><h1>Não foi possível abrir a loja</h1><p>{error}</p><button onClick={()=>location.reload()}>Tentar novamente</button></main>;
  if(catalog&&!catalog.store.enabled)return <main className="store-loading"><Store/><h1>Voltamos em breve</h1><p>A loja está temporariamente fechada.</p></main>;

  return <main className="store-page">
    <header className="store-header"><div className="store-brand"><span>WM</span><div><strong>{catalog?.store.name||"WM Vendas"}</strong><small>Walquíria Maia</small></div></div><Link href="/" className="store-admin"><ArrowLeft/> Área da vendedora</Link></header>
    <section className="store-intro"><div><small>BELEZA QUE ENCANTA</small><h1>Escolha seus favoritos</h1><p>Semijoias, perfumes e cosméticos selecionados para você.</p></div><span className="store-sparkle">WM</span></section>
    <section className="store-tools"><label><Search/><input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Buscar produtos…"/></label><div className="brand-pills">{brands.map(item=><button key={item} className={brand===item?"active":""} onClick={()=>setBrand(item)}>{item}</button>)}</div></section>
    <section className="store-grid">{products.map(product=>{const item=cart.find(i=>i.id===product.id);return <article className={product.stock>0?"store-product":"store-product sold-out"} key={product.id}><button className="store-photo" onClick={()=>setSelectedProduct(product)} aria-label={`Ver detalhes de ${product.name}`}>{product.photoUrl?<Image src={product.photoUrl} alt={product.name} fill sizes="(max-width: 640px) 50vw, 260px" unoptimized/>:<ShoppingBag/>}<span>{product.brand}</span><i><Info/> Ver detalhes</i></button><div className="store-product-body"><h2 onClick={()=>setSelectedProduct(product)}>{product.name}</h2><strong>{money(product.price)}</strong><small>{product.stock<1?"Produto esgotado":product.stock===1?"Última unidade":`${product.stock} disponíveis`}</small>{item?<div className="quantity"><button onClick={()=>change(product,-1)} aria-label="Diminuir"><Minus/></button><b>{item.quantity}</b><button onClick={()=>change(product,1)} disabled={item.quantity>=product.stock} aria-label="Aumentar"><Plus/></button></div>:<button className="add-cart" disabled={product.stock<1} onClick={()=>change(product,1)}>{product.stock<1?<><ShoppingBag/> Esgotado</>:<><Plus/> Adicionar à cesta</>}</button>}</div></article>})}</section>
    {!products.length&&<section className="store-empty"><ShoppingBag/><h2>Nenhum produto encontrado</h2><p>Tente outra busca ou categoria.</p></section>}
    {count>0&&<button className="cart-fab" onClick={()=>setCartOpen(true)}><span><ShoppingBag/><i>{count}</i></span><b>Ver sacola</b><strong>{money(total)}</strong></button>}

    {selectedProduct&&<div className="store-overlay"><section className="product-detail-sheet"><button className="detail-close" onClick={()=>setSelectedProduct(null)}><X/></button><div className="detail-photo">{selectedProduct.photoUrl?<Image src={selectedProduct.photoUrl} alt={selectedProduct.name} fill sizes="600px" unoptimized/>:<ShoppingBag/>}</div><small>{selectedProduct.brand}</small><h2>{selectedProduct.name}</h2><strong>{money(selectedProduct.price)}</strong><p>Produto disponível para retirada ou entrega. Você pode pagar por PIX ou solicitar uma reserva para aprovação da vendedora.</p><div className="detail-benefits"><span><ShieldCheck/> Preço confirmado pela loja</span><span><Clock3/> Reserva válida por até 24 horas</span></div><button className="add-cart" onClick={()=>{change(selectedProduct,1);setSelectedProduct(null)}}><Plus/> Adicionar à cesta</button></section></div>}

    {cartOpen&&<div className="store-overlay"><section className="cart-sheet"><header><div><small>SUA CESTA</small><h2>{count} {count===1?"produto":"produtos"}</h2></div><button onClick={()=>setCartOpen(false)} aria-label="Fechar"><X/></button></header><div className="cart-list">{cart.map(item=><article key={item.id}>{item.photoUrl?<div className="cart-thumb"><Image src={item.photoUrl} alt="" fill sizes="64px" unoptimized/></div>:<div className="cart-thumb"><ShoppingBag/></div>}<div className="cart-item-info"><small>{item.brand}</small><b>{item.name}</b><small>{money(item.price)} por unidade</small></div><div className="quantity"><button onClick={()=>change(item,-1)}><Minus/></button><b>{item.quantity}</b><button onClick={()=>change(item,1)} disabled={item.quantity>=item.stock}><Plus/></button></div><strong>{money(item.price*item.quantity)}</strong><button className="remove" onClick={()=>setCart(c=>c.filter(i=>i.id!==item.id))}><Trash2/></button></article>)}</div><div className="cart-assurance"><ShieldCheck/><span>Preço e disponibilidade serão confirmados com segurança ao finalizar.</span></div><footer><div><span>Total da cesta</span><strong>{money(total)}</strong></div><button className="checkout-button" onClick={()=>{setCartOpen(false);setCheckout(true)}}>Escolher entrega e pagamento <ChevronRight/></button></footer></section></div>}

    {checkout&&<div className="store-overlay"><section className="checkout-sheet"><header><div><small>FINALIZAR PEDIDO</small><h2>Entrega e pagamento</h2></div><button onClick={()=>setCheckout(false)}><X/></button></header><form onSubmit={placeOrder}><label>Nome completo<input name="customerName" required minLength={2} autoFocus/></label><label>WhatsApp<input name="phone" required inputMode="tel" placeholder="(00) 00000-0000"/></label><label>Como deseja receber?<select name="deliveryType" defaultValue="retirada" onChange={e=>{const address=e.currentTarget.form?.elements.namedItem("address") as HTMLInputElement|null;if(address)address.required=e.target.value==="entrega"}}><option value="retirada">Retirar com a vendedora</option><option value="entrega">Receber no endereço</option></select></label><label>Endereço para entrega<input name="address" placeholder="Preencha somente se escolher entrega"/></label><fieldset className="payment-options"><legend>Como deseja concluir?</legend><button type="button" className={paymentMethod==="pix"?"active":""} onClick={()=>setPaymentMethod("pix")}><span><b>Pagar com PIX</b><small>Gere o código e envie o comprovante</small></span><Check/></button><button type="button" className={paymentMethod==="reservation"?"active":""} onClick={()=>setPaymentMethod("reservation")}><span><b>Solicitar reserva</b><small>A vendedora confirma posteriormente</small></span><Clock3/></button></fieldset><p className="reservation-note"><Info/> Os produtos saem da disponibilidade ao concluir. Se a reserva não for aprovada, o estoque será devolvido.</p>{error&&<p className="store-error">{error}</p>}<div className="checkout-total"><span>{paymentMethod==="pix"?"Total por PIX":"Total da reserva"}</span><strong>{money(total)}</strong></div><button className="checkout-button" disabled={saving}>{saving?<Loader2 className="spin"/>:<ShoppingBag/>} {paymentMethod==="pix"?"Criar pedido e pagar":"Enviar solicitação de reserva"}</button></form></section></div>}

    {order&&<div className="store-overlay"><section className="pix-sheet"><span className="success-mark"><Check/></span><small>PEDIDO Nº {order.order.id}</small><h2>{order.order.paymentMethod==="reservation"?"Reserva solicitada!":"Pedido reservado!"}</h2><p>{order.order.paymentMethod==="reservation"?<>A solicitação de <b>{money(order.order.total)}</b> foi enviada. A vendedora confirmará a reserva pelo WhatsApp.</>:<>Copie o código PIX abaixo e faça o pagamento de <b>{money(order.order.total)}</b>.</>}</p>{order.pix&&<><div className="pix-holder"><small>Recebedor</small><b>{order.pix.holder}</b><span>{order.pix.key}</span></div><button className="copy-pix" onClick={copyPix}><Copy/> Copiar PIX Copia e Cola</button></>}<button className="whatsapp-order" onClick={sendReceipt}>{order.order.paymentMethod==="reservation"?"Avisar a vendedora no WhatsApp":"Enviar comprovante pelo WhatsApp"}</button><button className="close-order" onClick={()=>setOrder(null)}>Continuar na loja</button></section></div>}
  </main>;
}
