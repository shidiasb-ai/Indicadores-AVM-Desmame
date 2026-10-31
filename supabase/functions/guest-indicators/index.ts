import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const CAPACIDADE_SETORES: Record<string, number> = {
  "UTI GERAL": 10, "CARDIO": 10, "UTI CIR A": 10, "UTI CIR B": 16, "VERMELHA": 12,
};
const isoDate = (v: unknown) => {
  const s = String(v ?? "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : "";
};
const daysBetween = (start: string, end: string) => {
  if (!start || !end || end < start) return null;
  const a = new Date(start + "T00:00:00Z").getTime();
  const b = new Date(end + "T00:00:00Z").getTime();
  return Math.round((b - a) / 86400000);
};
const inside = (date: string, start: string, end: string) =>
  !!date && (!start || date >= start) && (!end || date <= end);
const getStartAVM = (p: any) => {
  const adm=isoDate(p?.dataAdm), iot=isoDate(p?.dataIOT);
  const history=Object.entries(p?.historico||{}).filter(([d,v])=>isoDate(d)&&v==="AVM"&&(!adm||String(d)>=adm)).map(([d])=>String(d)).sort();
  if(iot&&(!adm||iot>=adm))return iot;
  // Paciente já chega intubado ao setor: a contagem setorial começa na admissão.
  if(adm)return adm;
  return iot||history[0]||"";
};
const getEvents = (p: any, start: string) => {
  const events: {date:string; avm:boolean; order:number}[]=[{date:start,avm:true,order:0}];
  for(const [date,status] of Object.entries(p?.historico||{}))if(isoDate(date)&&String(date)>=start)events.push({date:String(date),avm:status==="AVM",order:2});
  for(const c of Array.isArray(p?.ciclos)?p.ciclos:[]){
    const ext=isoDate(c?.dataExt),ret=isoDate(c?.dataRetot);
    if(ext&&ext>=start)events.push({date:ext,avm:false,order:1});
    if(c?.teveRetot&&ret&&ret>=start)events.push({date:ret,avm:true,order:1});
  }
  return events.sort((a,b)=>a.date.localeCompare(b.date)||a.order-b.order);
};
const isAVMOnDay = (events: {date:string;avm:boolean;order:number}[], day:string) => {
  let state=false;
  for(const e of events)if(e.date<=day)state=e.avm;
  return state;
};
const avmDays = (p:any,start:string,end:string) => {
  const beginning=getStartAVM(p);
  if(!beginning||!start||!end||end<start)return 0;
  const outcome=isoDate(p?.dataDesfecho);
  const stop=[end,outcome&&String(p?.desfecho||"").toUpperCase()!=="ATIVO"?outcome:end].sort()[0];
  const from=beginning>start?beginning:start;
  if(stop<from)return 0;
  const events=getEvents(p,beginning);let count=0;
  for(let d=new Date(from+"T00:00:00Z");d<=new Date(stop+"T00:00:00Z");d.setUTCDate(d.getUTCDate()+1))if(isAVMOnDay(events,d.toISOString().slice(0,10)))count++;
  return count;
};
const normalizeSector = (value: unknown) => {
  const s=String(value||"").trim().toUpperCase();
  return s==="SALA VERMELHA"||s==="UTI VERMELHA"?"VERMELHA":s;
};
const patientKey = (p:any) => {
  const reg=String(p?.registro||p?.prontuario||"").trim().toUpperCase().replace(/\\s+/g,"");
  if(reg)return "R:"+reg;
  const name=String(p?.nome||"").trim().toUpperCase().normalize("NFD").replace(/[\\u0300-\\u036f]/g,"").replace(/\\s+/g," ");
  return name?"N:"+name:"ID:"+String(p?.id||p?.app_id||"");
};
const belongsEventToSector = (p:any,eventDate:string) => {
  const adm=isoDate(p?.dataAdm);
  // Sem data de admissão não é possível validar a atribuição setorial do evento.
  return !!adm && !!eventDate && eventDate>=adm;
};
const isRecordAVMOnDay = (p:any,day:string) => {
  const start=getStartAVM(p),outcome=isoDate(p?.dataDesfecho);
  if(!start||day<start||(String(p?.desfecho||"").toUpperCase()!=="ATIVO"&&outcome&&day>outcome))return false;
  return isAVMOnDay(getEvents(p,start),day);
};
const totalAVMDuration = (p:any) => {
  const start=getStartAVM(p);if(!start)return 0;
  const outcome=isoDate(p?.dataDesfecho),today=new Date().toISOString().slice(0,10);
  const end=String(p?.desfecho||"").toUpperCase()!=="ATIVO"&&outcome?outcome:today;
  return avmDays(p,start,end);
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Método não permitido." }, 405);
  try {
    const url = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !serviceKey) return json({ error: "Configure SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY na função." }, 500);
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    if (!token) return json({ error: "Sessão não autenticada." }, 401);

    const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: authData, error: authError } = await admin.auth.getUser(token);
    if (authError || !authData.user) return json({ error: "Sessão inválida ou expirada." }, 401);

    const { data: profile, error: profileError } = await admin
      .from("perfis_usuarios").select("id,perfil,ativo").eq("id", authData.user.id).maybeSingle();
    if (profileError || !profile || !profile.ativo || profile.perfil !== "convidado") {
      return json({ error: "Consulta disponível somente para o perfil Convidado ativo." }, 403);
    }

    let body: Record<string, unknown> = {};
    try { body = await req.json(); } catch { body = {}; }
    const start = isoDate(body.dataInicio);
    const end = isoDate(body.dataFim);
    if (start && end && end < start) return json({ error: "A data final não pode ser anterior à inicial." }, 400);

    const patients: any[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await admin.from("pacientes").select("app_id,dados").order("app_id").range(from, from + 999);
      if (error) return json({ error: "Não foi possível consultar os dados para agregação." }, 500);
      patients.push(...(data || []));
      if (!data || data.length < 1000) break;
    }

    const censo: any[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await admin.from("censo_rondas").select("data_ronda,dados").order("data_ronda").range(from, from + 999);
      if (error) return json({ error: "Não foi possível consultar o censo para calcular os internados-dias." }, 500);
      censo.push(...(data || []));
      if (!data || data.length < 1000) break;
    }

    const startDate = start || "2026-10-01";
    const endDate = end || new Date().toISOString().slice(0, 10);
    const span = Math.max(1, (daysBetween(startDate, endDate) ?? 0) + 1);
    const stats: Record<string, any> = {};
    const daily: Record<string, { data: string; avm: number; internados: number | null }> = {};
    const censoPresente: Record<string, Set<string>> = {};
    const censoSetorDia: Record<string, Record<string, number>> = {};
    for (let t = new Date(startDate + "T00:00:00Z"); t <= new Date(endDate + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() + 1)) {
      const day = t.toISOString().slice(0, 10);
      daily[day] = { data: day, avm: 0, internados: 0 };
      censoPresente[day]=new Set<string>();
      censoSetorDia[day]={};
    }
    const ensure = (sector: string) => {
      if (!stats[sector]) stats[sector] = {
        setor: sector, total: 0, pacientesAVM:0, diasAVM: 0, diasTotalAVM:0, avmDiasTaxa:0, internadosDia: 0, ocupacaoCompleta:true,
        totExt: 0, totRetot: 0, falhas48h: 0, programada: 0, autoextubacao: 0, acidental: 0,
        tqt: 0, obitos: 0, diasIOTTQT: 0, qtdIOTTQT: 0,
        desfechos: { ativos: 0, sucesso: 0, transferencia: 0, obitos: 0 },
      };
      return stats[sector];
    };
    for (const sector of Object.keys(CAPACIDADE_SETORES)) ensure(sector);

    for (const row of censo) {
      const date = isoDate(row.data_ronda);
      if (!inside(date, startDate, endDate) || !row.dados || typeof row.dados !== "object") continue;
      for (const [sector, value] of Object.entries(row.dados)) {
        const s = ensure(sector);
        const count = Math.max(0, Number(value) || 0);
        s.internadosDia += count;
        if (daily[date]) { daily[date].internados = (daily[date].internados||0) + count; censoPresente[date].add(sector); censoSetorDia[date][sector]=count; }
      }
    }
    // Agrupa os vários registros/ciclos do mesmo paciente no mesmo setor.
    // A contagem diária usa a união dos episódios, sem somar duas vezes o mesmo paciente-dia.
    const patientGroups=new Map<string,{sector:string;key:string;rows:any[]}>();
    for(const row of patients){
      const p=row?.dados||{};
      const sector=normalizeSector(p.setor||"NÃO INFORMADO");
      const key=sector+"|"+patientKey(p);
      if(!patientGroups.has(key))patientGroups.set(key,{sector,key,rows:[]});
      patientGroups.get(key)!.rows.push({...p,id:row.app_id});
    }
    for(const day of Object.keys(daily)){
      for(const group of patientGroups.values()){
        if(group.rows.some(p=>isRecordAVMOnDay(p,day))){
          const s=ensure(group.sector);
          s.avmDiasTaxa=(s.avmDiasTaxa||0)+1;
          daily[day].avm+=1;
        }
      }
    }
    // Consolidar AVM-pacientes, AVM-Dia e eventos TQT sem duplicar ciclos/registros.
    for(const group of patientGroups.values()){
      const s=ensure(group.sector);
      let patientAVMDays=0;
      for(const day of Object.keys(daily)){
        if(group.rows.some(p=>isRecordAVMOnDay(p,day)))patientAVMDays++;
      }
      if(patientAVMDays>0){
        s.pacientesAVM++;
        s.diasAVM+=patientAVMDays;
        s.diasTotalAVM+=patientAVMDays;
        s.total++;
      }
      const outcomeRows=group.rows.filter(p=>String(p.desfecho||"").trim()!=="")
        .sort((a,b)=>isoDate(b.dataDesfecho).localeCompare(isoDate(a.dataDesfecho)));
      const outcomeRow=outcomeRows[0];
      if(outcomeRow){
        const outcome=String(outcomeRow.desfecho||"").toUpperCase();
        const outcomeDate=isoDate(outcomeRow.dataDesfecho);
        if(outcome==="ÓBITO"&&patientAVMDays>0&&inside(outcomeDate,startDate,endDate)){s.obitos++;s.desfechos.obitos++;}
        else if(outcome==="ATIVO")s.desfechos.ativos++;
        else if(outcome==="EXTOT SEM FALHA"||outcome==="DECANULADO SEM FALHA")s.desfechos.sucesso++;
        else if(outcome==="TRANSFERÊNCIA"||outcome==="ALTA HOSPITALAR")s.desfechos.transferencia++;
      }
      // Reúne ciclos complementares e remove apenas cópias idênticas do mesmo evento.
      const cycles=new Map<string,any>();
      for(const p of group.rows)for(const cycle of Array.isArray(p.ciclos)?p.ciclos:[]){
        const extDate=isoDate(cycle?.dataExt),retDate=isoDate(cycle?.dataRetot);
        if(!inside(extDate,startDate,endDate))continue;
        const eventKey=[extDate,String(cycle.tipoExt||""),retDate,String(cycle.numeroNotificacao||"")].join("|");
        if(!cycles.has(eventKey))cycles.set(eventKey,cycle);
      }
      for(const cycle of cycles.values()){
        s.totExt++;
        if(cycle.tipoExt==="PROGRAMADA")s.programada++;
        else if(cycle.tipoExt==="AUTOEXTUBACAO")s.autoextubacao++;
        else if(cycle.tipoExt==="ACIDENTAL")s.acidental++;
        const retDate=isoDate(cycle.dataRetot);
        if(cycle.teveRetot&&inside(retDate,startDate,endDate)){
          s.totRetot++;
          if(cycle.falha48h)s.falhas48h++;
        }
      }
      const tqtEvents=new Map<string,any>();
      for(const p of group.rows){
        const tqtDate=isoDate(p.dataTQT),iot=isoDate(p.dataIOT);
        if(!tqtDate||!inside(tqtDate,startDate,endDate)||!belongsEventToSector(p,tqtDate))continue;
        if(!iot||iot>tqtDate)continue;
        const existing=tqtEvents.get(tqtDate);
        if(!existing||iot>isoDate(existing.dataIOT))tqtEvents.set(tqtDate,p);
      }
      for(const [tqtDate,p] of tqtEvents){
        s.tqt++;
        const iot=isoDate(p.dataIOT),duration=daysBetween(iot,tqtDate);
        if(duration!==null){s.diasIOTTQT+=duration;s.qtdIOTTQT++;}
      }
    }
    const sectors = Object.values(stats).map((s: any) => {
      const nonProgrammed = s.autoextubacao + s.acidental;
      return {
        setor: s.setor, total: s.total, pacientesAVM:s.pacientesAVM, diasAVM: s.diasAVM,
        mediaAVM:s.pacientesAVM>0?s.diasTotalAVM/s.pacientesAVM:null, qtdPacientesAVM:s.pacientesAVM,
        internadosDia: Math.max(0, s.internadosDia),
        totExt: s.totExt, totRetot: s.totRetot, falhas48h: s.falhas48h,
        programada: s.programada, autoextubacao: s.autoextubacao, acidental: s.acidental, tqt: s.tqt, obitos: s.obitos,
        desfechos: s.desfechos,
        txUtilizacao: s.internadosDia > 0 ? Math.min(100, s.avmDiasTaxa / s.internadosDia * 100) : null,
        txNaoProg: s.totExt > 0 ? nonProgrammed / s.totExt * 100 : 0,
        txSucesso: s.totExt > 0 ? (s.totExt - s.falhas48h) / s.totExt * 100 : 0,
        txFalha: s.totExt > 0 ? s.falhas48h / s.totExt * 100 : 0,
        txTQT: s.total > 0 ? s.tqt / s.total * 100 : 0,
        txObito: s.total > 0 ? s.obitos / s.total * 100 : 0,
        mediaIOTTQT: s.qtdIOTTQT > 0 ? s.diasIOTTQT / s.qtdIOTTQT : null,
        qtdIOTTQT: s.qtdIOTTQT,
      };
    }).sort((a, b) => a.setor.localeCompare(b.setor, "pt-BR"));

    const total = sectors.reduce((a: any, s: any) => {
      for (const k of ["total","pacientesAVM","diasAVM","internadosDia","totExt","totRetot","falhas48h","autoextubacao","acidental","tqt","obitos","qtdIOTTQT"]) a[k] += Number(s[k]) || 0;
      a.diasTotalAVM+=(Number(s.mediaAVM)||0)*(Number(s.qtdPacientesAVM)||0);
      a.avmDiasTaxa+=Number(s.avmDiasTaxa)||0;
      a.diasIOTTQT += (Number(s.mediaIOTTQT) || 0) * (Number(s.qtdIOTTQT) || 0);
      return a;
    }, { total:0,pacientesAVM:0,diasAVM:0,diasTotalAVM:0,avmDiasTaxa:0,internadosDia:0,totExt:0,totRetot:0,falhas48h:0,autoextubacao:0,acidental:0,tqt:0,obitos:0,qtdIOTTQT:0,diasIOTTQT:0 });
    total.qtdPacientesAVM=total.pacientesAVM;
    total.mediaAVM=total.pacientesAVM>0?total.diasTotalAVM/total.pacientesAVM:null;
    total.ocupacaoCompleta=sectors.some((s:any)=>s.internadosDia>0);
    total.txUtilizacao = total.internadosDia > 0 ? Math.min(100, total.avmDiasTaxa / total.internadosDia * 100) : null;
    total.txNaoProg = total.totExt > 0 ? (total.autoextubacao + total.acidental) / total.totExt * 100 : 0;
    total.txSucesso = total.totExt > 0 ? (total.totExt - total.falhas48h) / total.totExt * 100 : 0;
    total.txFalha = total.totExt > 0 ? total.falhas48h / total.totExt * 100 : 0;
    total.txTQT = total.total > 0 ? total.tqt / total.total * 100 : 0;
    total.txObito = total.total > 0 ? total.obitos / total.total * 100 : 0;
    total.mediaIOTTQT = total.qtdIOTTQT > 0 ? total.diasIOTTQT / total.qtdIOTTQT : null;
    total.desfechos = sectors.reduce((a: any, s: any) => {
      for (const k of ["ativos", "sucesso", "transferencia", "obitos"]) a[k] += Number(s.desfechos?.[k]) || 0;
      return a;
    }, { ativos: 0, sucesso: 0, transferencia: 0, obitos: 0 });
    const evolucaoDiaria = Object.values(daily).map(d => ({ ...d, internados: d.internados===null?null:Math.max(0,d.internados) }));

    // Apenas valores agregados são retornados. Nenhum nome, registro, app_id ou linha individual sai da função.
    return json({ ok: true, dataInicio: startDate, dataFim: endDate, setores: sectors, total, evolucaoDiaria });
  } catch (e) {
    console.error("guest-indicators error", e);
    return json({ error: "Falha ao gerar os indicadores agregados." }, 500);
  }
});
