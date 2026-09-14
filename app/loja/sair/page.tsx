import Link from "next/link";
import { CheckCircle2, ShoppingBag } from "lucide-react";

export default function StoreExitPage(){
  return <main className="store-exit-page">
    <section>
      <span className="store-exit-mark"><CheckCircle2/></span>
      <small>WM VENDAS</small>
      <h1>Você saiu da loja</h1>
      <p>Sua cesta foi esvaziada. Nenhuma compra ou reserva foi realizada.</p>
      <Link href="/loja"><ShoppingBag/> Entrar novamente na loja</Link>
    </section>
  </main>;
}
