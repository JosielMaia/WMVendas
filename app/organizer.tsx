"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { Bell, CalendarClock, Check, ChevronDown, CircleDollarSign, ClipboardList, MessageCircle, Plus, RefreshCw, Wallet } from "lucide-react";

type RecordItem = {
  id: number;
  financeScope: "store" | "personal";
  entryType: string;
  personName: string | null;
  personPhone: string | null;
  description: string;
  category: string;
  amount: number;
  paidAmount: number;
  occurredAt: string;
  dueDate: string | null;
  status: "open" | "partial" | "paid" | "overdue" | "canceled";
  paymentMethod: string | null;
  notes: string | null;
  reminderAt: string | null;
  paidAt: string | null;
};

const money = (value: number) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value || 0);
const today = () => new Date().toLocaleDateString("en-CA");
const typeLabels: Record<string, string> = {
  sale_other_person: "Compra para outra pessoa",
  loan_given: "Dinheiro emprestado",
  loan_received: "Empréstimo recebido",
  income: "Entrada",
  expense: "Despesa",
  payable: "Conta a pagar",
  receivable: "Valor a receber",
};
const dateLabel = (value?: string | null) => value ? new Date(value + (value.length === 10 ? "T12:00:00" : "")).toLocaleDateString("pt-BR") : "Sem data";

export function OrganizerView({ api, notify }: { api: (action: string, payload?: Record<string, unknown>) => Promise<any>; notify: (message: string) => void }) {
  const [records, setRecords] = useState<RecordItem[]>([]);
  const [scope, setScope] = useState<"store" | "personal">("store");
  const [showForm, setShowForm] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [filter, setFilter] = useState("open");
  const [payingId, setPayingId] = useState<number | null>(null);
  const [paymentAmount, setPaymentAmount] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("pix");

  async function refresh() {
    setLoading(true);
    try {
      const result = await api("personal_records_list");
      setRecords(Array.isArray(result.records) ? result.records : []);
    } catch (error) {
      notify(error instanceof Error ? error.message : "Não foi possível carregar os registros.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void refresh(); }, []);

  const visible = useMemo(() => records
    .filter(item => item.financeScope === scope)
    .filter(item => filter === "all" || (filter === "open" ? ["open", "partial", "overdue"].includes(item.status) : filter === "today" ? item.dueDate === today() && item.status !== "paid" && item.status !== "canceled" : item.status === filter))
    .sort((a, b) => (a.dueDate || "9999-12-31").localeCompare(b.dueDate || "9999-12-31")), [records, scope, filter]);

  const active = records.filter(item => item.financeScope === scope && ["open", "partial", "overdue"].includes(item.status));
  const outstanding = active.reduce((sum, item) => sum + Math.max(0, item.amount - item.paidAmount), 0);
  const dueToday = active.filter(item => item.dueDate === today()).length;
  const overdue = active.filter(item => item.dueDate && item.dueDate < today()).length;

  async function createRecord(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const amountRaw = String(form.get("amount") || "").trim();
    const amount = Number(amountRaw.includes(",") ? amountRaw.replace(/\\./g, "").replace(",", ".") : amountRaw);
    if (!Number.isFinite(amount) || amount <= 0) {
      notify("Informe um valor maior que zero.");
      return;
    }
    setSaving(true);
    try {
      await api("create_personal_record", {
        financeScope: scope,
        entryType: String(form.get("entryType") || "expense"),
        personName: String(form.get("personName") || ""),
        personPhone: String(form.get("personPhone") || ""),
        description: String(form.get("description") || ""),
        category: String(form.get("category") || "Outros"),
        amount,
        occurredAt: String(form.get("occurredAt") || today()),
        dueDate: String(form.get("dueDate") || ""),
        reminderAt: String(form.get("reminderAt") || ""),
        notes: String(form.get("notes") || ""),
      });
      event.currentTarget.reset();
      setShowForm(false);
      notify("Registro salvo. Ele já aparece na sua organização.");
      await refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : "Não foi possível salvar o registro.");
    } finally {
      setSaving(false);
    }
  }

  async function registerPayment(item: RecordItem) {
    const raw = paymentAmount.trim();
    const amount = Number(raw.includes(",") ? raw.replace(/\\./g, "").replace(",", ".") : raw);
    const balance = Math.max(0, item.amount - item.paidAmount);
    if (!Number.isFinite(amount) || amount <= 0 || amount > balance + 0.001) {
      notify("Confira o valor. Ele não pode ser maior que o saldo em aberto.");
      return;
    }
    setSaving(true);
    try {
      await api("record_personal_payment", { id: item.id, amount, paymentMethod });
      setPayingId(null);
      setPaymentAmount("");
      notify("Pagamento registrado e saldo atualizado.");
      await refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : "Não foi possível registrar o pagamento.");
    } finally {
      setSaving(false);
    }
  }

  function reminderLink(item: RecordItem) {
    const phone = (item.personPhone || "").replace(/\\D/g, "");
    if (!phone) return "";
    const balance = Math.max(0, item.amount - item.paidAmount);
    const message = `Olá, ${item.personName || ""}! Passando para lembrar sobre ${item.description}, no valor pendente de ${money(balance)}. Vencimento: ${dateLabel(item.dueDate)}. Obrigada!`;
    return `https://wa.me/${phone.startsWith("55") ? phone : "55" + phone}?text=${encodeURIComponent(message)}`;
  }

  return (
    <section className="organizer-view">
      <header className="organizer-heading">
        <div><span>ORGANIZAÇÃO DO DIA A DIA</span><h1>Meu Dia</h1><p>Um só lugar para lembrar, registrar e acompanhar o que entra e o que sai.</p></div>
        <button className="organizer-refresh" onClick={() => void refresh()} disabled={loading}><RefreshCw/> Atualizar</button>
      </header>

      <div className="organizer-scope" role="tablist" aria-label="Área financeira">
        <button className={scope === "store" ? "active" : ""} onClick={() => { setScope("store"); setFilter("open"); }}><Wallet/> Loja</button>
        <button className={scope === "personal" ? "active" : ""} onClick={() => { setScope("personal"); setFilter("open"); }}><CircleDollarSign/> Pessoal e família</button>
      </div>

      <div className="organizer-stats">
        <article><span><ClipboardList/></span><small>Em aberto</small><strong>{money(outstanding)}</strong></article>
        <article><span><CalendarClock/></span><small>Vencem hoje</small><strong>{dueToday}</strong></article>
        <article><span><Bell/></span><small>Em atraso</small><strong>{overdue}</strong></article>
      </div>

      <section className="organizer-capture">
        <div><b>Registrar agora</b><p>Não deixe para anotar depois. Registre em poucos segundos.</p></div>
        <button onClick={() => setShowForm(value => !value)}><Plus/> {showForm ? "Fechar" : "Novo registro"} <ChevronDown className={showForm ? "turned" : ""}/></button>
      </section>

      {showForm && <form className="organizer-form" onSubmit={createRecord}>
        <div className="organizer-form-title"><b>Novo registro</b><small>{scope === "store" ? "Movimentação da loja" : "Movimentação pessoal ou familiar"}</small></div>
        <label>O que deseja registrar?
          <select name="entryType" defaultValue={scope === "store" ? "sale_other_person" : "expense"}>
            <option value="sale_other_person">Compra para outra pessoa (a receber)</option>
            <option value="loan_given">Dinheiro que emprestei</option>
            <option value="loan_received">Dinheiro que peguei emprestado</option>
            <option value="receivable">Outro valor a receber</option>
            <option value="payable">Conta a pagar</option>
            <option value="income">Entrada de dinheiro</option>
            <option value="expense">Despesa / compra</option>
          </select>
        </label>
        <div className="organizer-form-grid">
          <label>Nome da pessoa (opcional)<input name="personName" placeholder="Ex.: Maria, fornecedor..." /></label>
          <label>WhatsApp (opcional)<input name="personPhone" inputMode="tel" placeholder="(91) 99999-9999" /></label>
          <label className="wide">Descrição<input name="description" required minLength={2} placeholder="Ex.: comprei um perfume para Maria" /></label>
          <label>Valor total<input name="amount" required inputMode="decimal" placeholder="0,00" /></label>
          <label>Categoria<input name="category" defaultValue={scope === "store" ? "Outros" : "Casa"} /></label>
          <label>Data do registro<input name="occurredAt" type="date" defaultValue={today()} /></label>
          <label>Data de vencimento (se houver)<input name="dueDate" type="date" /></label>
          <label className="wide">Lembrete (opcional)<input name="reminderAt" type="datetime-local" /></label>
          <label className="wide">Observações<textarea name="notes" rows={2} placeholder="Detalhes para não esquecer..." /></label>
        </div>
        <footer><button type="button" className="secondary" onClick={() => setShowForm(false)}>Cancelar</button><button type="submit" disabled={saving}>{saving ? "Salvando..." : "Salvar registro"}</button></footer>
      </form>}

      <div className="organizer-list-heading"><div><h2>Registros e lembretes</h2><p>Compras para terceiros, empréstimos, contas e recebimentos.</p></div>
        <div className="organizer-filters">
          <button className={filter === "open" ? "active" : ""} onClick={() => setFilter("open")}>Em aberto</button>
          <button className={filter === "today" ? "active" : ""} onClick={() => setFilter("today")}>Hoje</button>
          <button className={filter === "paid" ? "active" : ""} onClick={() => setFilter("paid")}>Pagos</button>
          <button className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>Todos</button>
        </div>
      </div>

      {loading ? <div className="organizer-empty">Carregando seus registros...</div> : visible.length === 0 ? <div className="organizer-empty"><ClipboardList/><b>Nenhum registro nesta lista</b><span>Use “Novo registro” para anotar uma compra, empréstimo ou conta.</span></div> :
        <div className="organizer-records">{visible.map(item => {
          const balance = Math.max(0, item.amount - item.paidAmount);
          const link = reminderLink(item);
          const status = item.status === "overdue" || (item.dueDate && item.dueDate < today() && balance > 0) ? "Em atraso" : item.status === "paid" ? "Quitado" : item.status === "partial" ? "Parcial" : "Em aberto";
          return <article className="organizer-record" key={item.id}>
            <div className="organizer-record-icon"><ClipboardList/></div>
            <div className="organizer-record-main">
              <div className="organizer-record-title"><b>{item.description}</b><span className={status === "Em atraso" ? "late" : status === "Quitado" ? "done" : "pending"}>{status}</span></div>
              <small>{typeLabels[item.entryType] || "Registro"}{item.personName ? ` · ${item.personName}` : ""}</small>
              <p>{item.category} · Registrado em {dateLabel(item.occurredAt)}{item.dueDate ? ` · Vencimento ${dateLabel(item.dueDate)}` : ""}</p>
              {item.notes && <p className="organizer-notes">{item.notes}</p>}
              {balance > 0 && <div className="organizer-record-actions">
                <button onClick={() => { setPayingId(payingId === item.id ? null : item.id); setPaymentAmount(balance.toFixed(2).replace(".", ",")); }}><Check/> Registrar pagamento/recebimento</button>
                {link && <a href={link} target="_blank" rel="noreferrer"><MessageCircle/> Lembrar no WhatsApp</a>}
              </div>}
              {payingId === item.id && <div className="organizer-payment">
                <label>Valor recebido/pago<input value={paymentAmount} onChange={event => setPaymentAmount(event.target.value)} inputMode="decimal"/></label>
                <label>Forma<select value={paymentMethod} onChange={event => setPaymentMethod(event.target.value)}><option value="pix">PIX</option><option value="dinheiro">Dinheiro</option><option value="transferencia">Transferência</option><option value="cartao">Cartão</option><option value="outro">Outro</option></select></label>
                <button disabled={saving} onClick={() => void registerPayment(item)}>{saving ? "Salvando..." : "Confirmar"}</button>
              </div>}
            </div>
            <div className="organizer-record-value"><strong>{money(item.amount)}</strong><small>Saldo {money(balance)}</small></div>
          </article>;
        })}</div>}
    </section>
  );
}
