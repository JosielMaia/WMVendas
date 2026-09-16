"use client";

import { FormEvent, useEffect, useState } from "react";
import { Loader2, ShieldCheck, UserPlus, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Member={id:string;name:string;email:string;role:"owner"|"admin"|"seller"|"viewer";active:boolean;current:boolean;createdAt:string};
type TeamData={members:Member[];limit:number};
const roles={owner:"Proprietário",admin:"Administrador",seller:"Vendedor",viewer:"Somente leitura"};

export function TeamView({api,notify,currentRole}:{api:(action:string,payload?:Record<string,unknown>)=>Promise<any>;notify:(message:string)=>void;currentRole:string}){
  const [data,setData]=useState<TeamData|null>(null),[loading,setLoading]=useState(true),[saving,setSaving]=useState(false);
  async function load(){try{setData(await api("team_list"))}catch(e){notify(e instanceof Error?e.message:"Não foi possível carregar a equipe")}finally{setLoading(false)}}
  useEffect(()=>{void load()},[]);
  async function create(e:FormEvent<HTMLFormElement>){e.preventDefault();setSaving(true);const form=e.currentTarget;try{const values=Object.fromEntries(new FormData(form));const result=await api("create_team_member",values);notify(result.message);form.reset();await load()}catch(e){notify(e instanceof Error?e.message:"Não foi possível criar o usuário")}finally{setSaving(false)}}
  async function update(member:Member,changes:Partial<Member>){try{const result=await api("update_team_member",{id:member.id,role:changes.role||member.role,active:changes.active??member.active});notify(result.message);await load()}catch(e){notify(e instanceof Error?e.message:"Não foi possível atualizar")}}
  if(loading)return <div className="center"><Loader2 className="spin"/> Carregando equipe…</div>;
  if(!data)return null;
  return <><div className="page-title"><div><small>ACESSO SEGURO</small><h1>Equipe da loja</h1></div><span className="team-limit"><Users/> {data.members.filter(x=>x.active).length}/{data.limit} ativos</span></div>
    <section className="team-grid"><form className="panel team-form" onSubmit={create}><div className="panel-head"><div><small>NOVO ACESSO</small><h2>Adicionar pessoa</h2></div><UserPlus/></div><div className="form"><div className="field full"><Label>Nome</Label><Input name="name" placeholder="Nome da pessoa" required/></div><div className="field full"><Label>E-mail</Label><Input name="email" type="email" autoComplete="email" placeholder="nome@email.com" required/></div><div className="field full"><Label>Senha temporária</Label><Input name="password" type="password" minLength={8} autoComplete="new-password" placeholder="Mínimo de 8 caracteres" required/></div><div className="field full"><Label>Perfil</Label><select name="role" defaultValue="seller"><option value="seller">Vendedor</option><option value="viewer">Somente leitura</option>{currentRole==="owner"&&<option value="admin">Administrador</option>}</select></div><Button className="full" disabled={saving||data.members.filter(x=>x.active).length>=data.limit}>{saving?<Loader2 className="spin"/>:<UserPlus/>} Criar acesso</Button></div></form>
      <section className="panel team-list"><div className="panel-head"><div><small>USUÁRIOS</small><h2>Permissões e bloqueio</h2></div><ShieldCheck/></div>{data.members.map(member=><article className={`team-member ${member.active?"":"disabled"}`} key={member.id}><span className="team-avatar">{member.name.slice(0,2).toUpperCase()}</span><div><b>{member.name}{member.current&&<em>Você</em>}</b><small>{member.email||"Acesso pelo PIN antigo"}</small></div><select value={member.role} disabled={member.role==="owner"||(currentRole!=="owner"&&member.role==="admin")} onChange={e=>void update(member,{role:e.target.value as Member["role"]})}><option value="owner">Proprietário</option><option value="admin">Administrador</option><option value="seller">Vendedor</option><option value="viewer">Somente leitura</option></select><Button size="sm" variant="outline" disabled={member.role==="owner"||member.current||(currentRole!=="owner"&&member.role==="admin")} onClick={()=>void update(member,{active:!member.active})}>{member.active?"Bloquear":"Reativar"}</Button><span className="role-help">{roles[member.role]}</span></article>)}{!data.members.length&&<div className="team-empty"><Users/><b>Nenhum usuário individual ainda</b><span>O PIN antigo continua funcionando como proprietário.</span></div>}</section>
    </section><div className="permission-note"><ShieldCheck/><div><b>Permissões por perfil</b><span>Administrador gerencia a operação; vendedor cadastra, vende e recebe; somente leitura não altera dados. O proprietário mantém controle total.</span></div></div></>;
}
