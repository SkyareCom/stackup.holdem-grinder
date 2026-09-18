"use client";
import { useState } from "react";

const cards=[
["⚙","CONFIGURAÇÕES","PREFERÊNCIAS E CONTROLES"],
["♠","SPOTS","TREINO E BIBLIOTECA DE SPOTS"],
["✦","IA E APK ON","ASSISTÊNCIA INTELIGENTE"],
["⌁","LEAK FINDER","ENCONTRE PADRÕES E FALHAS"],
["▣","HISTÓRICO","REVISE SUAS SESSÕES"],
["◎","PERFORMANCE","ACOMPANHE SUA EVOLUÇÃO"],
["▤","RELATÓRIOS","ANÁLISES E RESULTADOS"]
];

function Header(){
 return <header className="ev-head">
  <div className="ev-logo">SH</div>
  <div className="ev-brand"><h1>STACKUP HOLD’EM</h1><h2>EVOLUTION</h2><p>MAIS CONSISTÊNCIA. MELHOR DESEMPENHO.</p></div>
 </header>
}
function Cards({openSettings=false}){
 return <div className="ev-cards">{cards.map((c,i)=>
  <button className="ev-card" key={c[1]} onClick={i===0&&openSettings?openSettings:false}>
   <span className="ev-icon">{c[0]}</span><span className="ev-copy"><b>{c[1]}</b><small>{c[2]}</small></span><span className="ev-arrow">›</span>
  </button>)}</div>
}
export default function PurpleTemplate(){
 const [settings,setSettings]=useState(false);
 return <main className="ev-app">
  <Header/>
  {settings&&<div className="ev-nav"><button onClick={()=>setSettings(false)}>‹ VOLTAR</button><button onClick={()=>setSettings(false)}>⌂ MENU PRINCIPAL</button></div>}
  <Cards openSettings={!settings?()=>setSettings(true):false}/>
 </main>
}