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
    const daily: Record<string, { data: string; avm: number; internados: number }> = {};
    for (let t = new Date(startDate + "T00:00:00Z"); t <= new Date(endDate + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() + 1)) {
      const day = t.toISOString().slice(0, 10);
      daily[day] = { data: day, avm: 0, internados: Object.values(CAPACIDADE_SETORES).reduce((sum, n) => sum + n, 0) };
    }
    const ensure = (sector: string) => {
      if (!stats[sector]) stats[sector] = {
        setor: sector, total: 0, diasAVM: 0, internadosDia: (CAPACIDADE_SETORES[sector] || 10) * span,
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
        const correction = Number(value) - (CAPACIDADE_SETORES[sector] || 10);
        s.internadosDia += correction;
        if (daily[date]) daily[date].internados += correction;
      }
    }

    for (const row of patients) {
      const p = row?.dados || {};
      const iot = isoDate(p.dataIOT);
      const outcomeDate = isoDate(p.dataDesfecho);
      if (startDate && iot && iot < startDate && (!outcomeDate || outcomeDate < startDate)) continue;
      if (endDate && iot && iot > endDate) continue;
      const sector = String(p.setor || "NÃO INFORMADO").trim().slice(0, 80) || "NÃO INFORMADO";
      const s = ensure(sector);
      s.total += 1;
      s.diasAVM += Number(p.tempoAVM) || 0;
      const tqtDate = isoDate(p.dataTQT);
      if (tqtDate) s.tqt += 1;
      if (iot && tqtDate && tqtDate >= iot) {
        s.diasIOTTQT += daysBetween(iot, tqtDate) || 0;
        s.qtdIOTTQT += 1;
      }
      const outcome = String(p.desfecho || "").toUpperCase();
      if (outcome === "ÓBITO") { s.obitos += 1; s.desfechos.obitos += 1; }
      else if (outcome === "ATIVO") s.desfechos.ativos += 1;
      else if (outcome === "EXTOT SEM FALHA" || outcome === "DECANULADO SEM FALHA") s.desfechos.sucesso += 1;
      else if (outcome === "TRANSFERÊNCIA" || outcome === "ALTA HOSPITALAR") s.desfechos.transferencia += 1;
      if (iot) {
        const dailyStart = iot > startDate ? iot : startDate;
        const stop = outcomeDate && outcomeDate < endDate ? outcomeDate : endDate;
        if (stop >= dailyStart) {
          for (let t = new Date(dailyStart + "T00:00:00Z"); t <= new Date(stop + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() + 1)) {
            const day = t.toISOString().slice(0, 10);
            if (daily[day]) daily[day].avm += 1;
          }
        }
      }
      if (Array.isArray(p.ciclos)) {
        for (const c of p.ciclos) {
          const extDate = isoDate(c?.dataExt);
          if (!inside(extDate, startDate, endDate)) continue;
          s.totExt += 1;
          if (c.tipoExt === "PROGRAMADA") s.programada += 1;
          else if (c.tipoExt === "AUTOEXTUBACAO") s.autoextubacao += 1;
          else if (c.tipoExt === "ACIDENTAL") s.acidental += 1;
          if (c.teveRetot) {
            s.totRetot += 1;
            if (c.falha48h) s.falhas48h += 1;
          }
        }
      }
    }

    const sectors = Object.values(stats).map((s: any) => {
      const nonProgrammed = s.autoextubacao + s.acidental;
      return {
        setor: s.setor, total: s.total, diasAVM: s.diasAVM, internadosDia: Math.max(0, s.internadosDia),
        totExt: s.totExt, totRetot: s.totRetot, falhas48h: s.falhas48h,
        programada: s.programada, autoextubacao: s.autoextubacao, acidental: s.acidental, tqt: s.tqt, obitos: s.obitos,
        desfechos: s.desfechos,
        txUtilizacao: s.internadosDia > 0 ? Math.min(100, s.diasAVM / s.internadosDia * 100) : 0,
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
      for (const k of ["total","diasAVM","internadosDia","totExt","totRetot","falhas48h","autoextubacao","acidental","tqt","obitos","qtdIOTTQT"]) a[k] += Number(s[k]) || 0;
      a.diasIOTTQT += (Number(s.mediaIOTTQT) || 0) * (Number(s.qtdIOTTQT) || 0);
      return a;
    }, { total:0,diasAVM:0,internadosDia:0,totExt:0,totRetot:0,falhas48h:0,autoextubacao:0,acidental:0,tqt:0,obitos:0,qtdIOTTQT:0,diasIOTTQT:0 });
    total.txUtilizacao = total.internadosDia > 0 ? Math.min(100, total.diasAVM / total.internadosDia * 100) : 0;
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
    const evolucaoDiaria = Object.values(daily).map(d => ({ ...d, internados: Math.max(0, d.internados) }));

    // Apenas valores agregados são retornados. Nenhum nome, registro, app_id ou linha individual sai da função.
    return json({ ok: true, dataInicio: startDate, dataFim: endDate, setores: sectors, total, evolucaoDiaria });
  } catch (e) {
    console.error("guest-indicators error", e);
    return json({ error: "Falha ao gerar os indicadores agregados." }, 500);
  }
});
