import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const isoDate = (v: unknown) => {
  const s = String(v ?? "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : "";
};
const daysBetween = (start: string, end: string) => {
  if (!start || !end || end < start) return null;
  return Math.round((Date.parse(start + "T00:00:00Z") - Date.parse(end + "T00:00:00Z")) / -86400000);
};
const inside = (date: string, start: string, end: string) =>
  !!date && (!start || date >= start) && (!end || date <= end);
const normalizeSector = (value: unknown) => {
  const s = String(value || "").trim().toUpperCase();
  return s === "SALA VERMELHA" || s === "UTI VERMELHA" ? "VERMELHA" : s;
};
const patientKey = (p: any) => {
  const reg = String(p?.registro || p?.prontuario || "").trim().toUpperCase().replace(/\s+/g, "");
  if (reg) return "R:" + reg;
  const name = String(p?.nome || "").trim().toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ");
  return name ? "N:" + name : "ID:" + String(p?.id || p?.app_id || "");
};
const effectiveStart = (p: any) => {
  const adm = isoDate(p?.dataAdm), iot = isoDate(p?.dataIOT);
  if (!adm) return "";
  if (iot && iot > adm) return iot;
  return adm;
};
const groupAdmission = (rows: any[]) => rows.map(p => isoDate(p.dataAdm)).filter(Boolean).sort()[0] || "";

type EventState = { date: string; state: boolean; priority: number; key: string };
const buildGroupTimeline = (rows: any[]) => {
  const events: EventState[] = [];
  const admission = groupAdmission(rows);
  if (!admission) return { admission: "", events: [] as EventState[] };
  for (const p of rows) {
    const adm = isoDate(p.dataAdm);
    const start = effectiveStart(p);
    if (start && start >= adm) events.push({ date: start, state: true, priority: 0, key: "START:" + start });
    for (const [rawDate, rawStatus] of Object.entries(p.historico || {})) {
      const date = isoDate(rawDate);
      if (!date || date < adm || date < admission) continue;
      const status = String(rawStatus || "").toUpperCase();
      if (status === "AVM") events.push({ date, state: true, priority: 3, key: "H:AVM:" + date });
      else if (status === "RE" || status === "DESCONEXÃO" || status === "DESCONEXAO") {
        events.push({ date, state: false, priority: 3, key: "H:OFF:" + date });
      }
    }
    for (const c of Array.isArray(p.ciclos) ? p.ciclos : []) {
      const ext = isoDate(c?.dataExt), ret = isoDate(c?.dataRetot);
      if (ext && ext >= adm && ext >= admission) events.push({ date: ext, state: false, priority: 1, key: "EXT:" + ext + ":" + String(c.ciclo || c.numeroCiclo || c.tipoExt || "") + ":" + String(c.numeroNotificacao || "") });
      if (c?.teveRetot && ret && ret >= adm && ret >= admission) events.push({ date: ret, state: true, priority: 2, key: "RET:" + ret + ":" + String(c.ciclo || c.numeroCiclo || "") });
    }
  }
  const unique = new Map<string, EventState>();
  for (const e of events) unique.set(e.key, e);
  const sorted = [...unique.values()].sort((a, b) => a.date.localeCompare(b.date) || a.priority - b.priority);
  return { admission, events: sorted };
};
const groupAVMOnDay = (timeline: { admission: string; events: EventState[] }, day: string, outcomeDate = "", active = true) => {
  if (!timeline.admission || day < timeline.admission || (outcomeDate && !active && day > outcomeDate)) return false;
  let state = false;
  for (const e of timeline.events) if (e.date <= day) state = e.state;
  return state;
};
const getOutcome = (rows: any[]) => rows
  .filter(p => String(p.desfecho || "").trim() && isoDate(p.dataDesfecho))
  .sort((a, b) => isoDate(b.dataDesfecho).localeCompare(isoDate(a.dataDesfecho)))[0] || null;
const eventIdentity = (c: any, ext: string, ret: string) =>
  [ext, String(c?.ciclo || c?.numeroCiclo || ""), String(c?.tipoExt || ""), ret, String(c?.numeroNotificacao || "")].join("|");

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
    const start = isoDate(body.dataInicio), end = isoDate(body.dataFim);
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

    const today = new Date().toISOString().slice(0, 10);
    const startDate = start || "2026-11-01";
    const endDate = end || (today < startDate ? startDate : today);
    const stats: Record<string, any> = {};
    const daily: Record<string, { data: string; avm: number; internados: number | null }> = {};
    const censoByDay: Record<string, Record<string, number>> = {};
    const avmPatientsByDay: Record<string, Record<string, Set<string>>> = {};
    const patientsBySector: Record<string, Set<string>> = {};
    const deathKeys = new Set<string>();
    for (let t = new Date(startDate + "T00:00:00Z"); t <= new Date(endDate + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() + 1)) {
      const day = t.toISOString().slice(0, 10);
      daily[day] = { data: day, avm: 0, internados: null };
      censoByDay[day] = {};
      avmPatientsByDay[day] = {};
    }
    const ensure = (sector: string) => {
      if (!stats[sector]) stats[sector] = {
        setor: sector, total: 0, pacientesAVM: 0, diasAVM: 0, avmDiasTaxa: 0,
        internadosDia: 0, diasComCenso: 0, totExt: 0, totRetot: 0, falhas48h: 0,
        programada: 0, autoextubacao: 0, acidental: 0, notificadas: 0, tqt: 0, obitos: 0,
        extAvaliaveis: 0, extSucesso: 0, extPendentes: 0,
        diasIOTTQT: 0, qtdIOTTQT: 0, diasIOTExt: 0, qtdIOTExt: 0,
        diasTQTDecanul: 0, qtdTQTDecanul: 0,
        desfechos: { ativos: 0, sucesso: 0, transferencia: 0, obitos: 0 },
      };
      return stats[sector];
    };

    const setoresConhecidos = new Set<string>(
      patients.map(row => normalizeSector(row?.dados?.setor)).filter(Boolean)
    );
    for (const row of censo) {
      const date = isoDate(row.data_ronda);
      if (!inside(date, startDate, endDate) || !row.dados || typeof row.dados !== "object") continue;
      for (const [rawSector, value] of Object.entries(row.dados)) {
        const sector = normalizeSector(rawSector), count = Number(value);
        if (!sector || !Number.isFinite(count) || count < 0) continue;
        setoresConhecidos.add(sector);
        ensure(sector);
        censoByDay[date][sector] = count;
      }
    }
    for (const day of Object.keys(daily)) {
      const sectorsWithCensus = Object.keys(censoByDay[day]);
      daily[day].internados = setoresConhecidos.size > 0 && [...setoresConhecidos].every(sector => Object.prototype.hasOwnProperty.call(censoByDay[day], sector))
        ? [...setoresConhecidos].reduce((sum, sector) => sum + censoByDay[day][sector], 0)
        : null;
      for (const sector of sectorsWithCensus) {
        const s = ensure(sector);
        s.internadosDia += censoByDay[day][sector];
        s.diasComCenso++;
      }
    }

    const groups = new Map<string, { sector: string; key: string; patientKey: string; admission: string; rows: any[] }>();
    for (const row of patients) {
      const p = { ...(row?.dados || {}), app_id: row.app_id };
      const sector = normalizeSector(p.setor || "NÃO INFORMADO");
      const pk = patientKey(p), admission = isoDate(p.dataAdm);
      const key = sector + "|" + pk + "|" + admission;
      if (!groups.has(key)) groups.set(key, { sector, key, patientKey: pk, admission, rows: [] });
      groups.get(key)!.rows.push(p);
    }

    for (const group of groups.values()) {
      const s = ensure(group.sector);
      const timeline = buildGroupTimeline(group.rows);
      const outcomeRow = getOutcome(group.rows);
      const outcome = String(outcomeRow?.desfecho || "").trim().toUpperCase();
      const outcomeDate = isoDate(outcomeRow?.dataDesfecho);
      const active = !outcome || outcome === "ATIVO";
      const groupDays = new Set<string>();

      for (const day of Object.keys(daily)) {
        if (groupAVMOnDay(timeline, day, outcomeDate, active) && day <= today) {
          groupDays.add(day);
          if (!avmPatientsByDay[day][group.sector]) avmPatientsByDay[day][group.sector] = new Set<string>();
          avmPatientsByDay[day][group.sector].add(group.patientKey);
        }
      }
      if (groupDays.size) {
        if (!patientsBySector[group.sector]) patientsBySector[group.sector] = new Set<string>();
        patientsBySector[group.sector].add(group.patientKey);
      }

      if (outcome === "ÓBITO" && groupDays.size && inside(outcomeDate, startDate, endDate)) {
        const deathKey = group.sector + "|" + group.patientKey + "|" + outcomeDate;
        if (!deathKeys.has(deathKey)) { s.obitos++; s.desfechos.obitos++; deathKeys.add(deathKey); }
      } else if (outcome === "ATIVO") s.desfechos.ativos++;
      else if (outcome === "EXTOT SEM FALHA" || outcome === "DECANULADO SEM FALHA") s.desfechos.sucesso++;
      else if (outcome === "TRANSFERÊNCIA" || outcome === "ALTA HOSPITALAR") s.desfechos.transferencia++;

      // Consolidar ciclos complementares do mesmo paciente/setor; cada evento é contado uma vez.
      const cycles = new Map<string, any>();
      for (const p of group.rows) {
        const adm = isoDate(p.dataAdm);
        for (const c of Array.isArray(p.ciclos) ? p.ciclos : []) {
          const ext = isoDate(c?.dataExt), ret = isoDate(c?.dataRetot);
          if (!adm) continue;
          const id = eventIdentity(c, ext, ret);
          if (!cycles.has(id)) cycles.set(id, c);
        }
      }
      const iotDates = group.rows.map(p => isoDate(p.dataIOT)).filter(Boolean).sort();
      const initialIOT = iotDates[0] || "";
      const initialStart = timeline.admission && initialIOT
        ? (initialIOT > timeline.admission ? initialIOT : timeline.admission)
        : timeline.admission;
      const retotDates = [...cycles.values()].map(c => isoDate(c.dataRetot)).filter(Boolean).sort();

      for (const c of cycles.values()) {
        const ext = isoDate(c.dataExt), ret = isoDate(c.dataRetot);
        if (ext && inside(ext, startDate, endDate) && ext >= timeline.admission) {
          s.totExt++;
          if (c.tipoExt === "PROGRAMADA") s.programada++;
          else if (c.tipoExt === "AUTOEXTUBACAO") s.autoextubacao++;
          else if (c.tipoExt === "ACIDENTAL") s.acidental++;
          if ((c.tipoExt === "AUTOEXTUBACAO" || c.tipoExt === "ACIDENTAL") && String(c.numeroNotificacao || "").trim()) s.notificadas++;

          if (c.teveRetot && ret) {
            const gap = daysBetween(ext, ret);
            if (gap !== null && gap >= 0) {
              s.extAvaliaveis++;
              const failure = typeof c.falha48h === "boolean" ? c.falha48h : gap <= 1;
              if (failure) s.falhas48h++;
              else s.extSucesso++;
            } else s.extPendentes++;
          } else {
            const followup = daysBetween(ext, today);
            if (followup !== null && followup >= 2) { s.extAvaliaveis++; s.extSucesso++; }
            else s.extPendentes++;
          }
          // Tempo IOT/RE-IOT até a extubação, usando o início do episódio correspondente.
          const priorRetot = retotDates.filter(d => d <= ext).sort().pop() || "";
          const episodeStart = priorRetot && priorRetot > initialStart ? priorRetot : initialStart;
          const duration = daysBetween(episodeStart, ext);
          if (duration !== null && duration >= 0) { s.diasIOTExt += duration; s.qtdIOTExt++; }
        }
        if (c.teveRetot && ret && inside(ret, startDate, endDate) && ret >= timeline.admission) s.totRetot++;
      }

      // TQT e decanulação são eventos do setor onde a data do procedimento ocorreu.
      const tqtDates = new Set<string>();
      const decanDates = new Set<string>();
      for (const p of group.rows) {
        const adm = isoDate(p.dataAdm), tqt = isoDate(p.dataTQT), decan = isoDate(p.dataDecanul);
        if (tqt && adm && tqt >= adm && tqt >= timeline.admission) tqtDates.add(tqt);
        if (decan && adm && decan >= adm && decan >= timeline.admission) decanDates.add(decan);
      }
      for (const tqt of tqtDates) {
        if (!inside(tqt, startDate, endDate)) continue;
        s.tqt++;
        const eligibleIOT = group.rows.map(p => {
          const adm = isoDate(p.dataAdm), iot = isoDate(p.dataIOT);
          if (!adm || !iot || iot > tqt) return "";
          return iot > adm ? iot : adm;
        }).filter(Boolean).sort();
        const startIOT = eligibleIOT.sort().pop() || "";
        const duration = daysBetween(startIOT, tqt);
        if (duration !== null && duration >= 0) { s.diasIOTTQT += duration; s.qtdIOTTQT++; }
      }
      for (const decan of decanDates) {
        if (!inside(decan, startDate, endDate)) continue;
        const eligibleTQT = [...tqtDates].filter(d => d <= decan).sort().pop() || "";
        const duration = daysBetween(eligibleTQT, decan);
        if (duration !== null && duration >= 0) { s.diasTQTDecanul += duration; s.qtdTQTDecanul++; }
      }
    }

    // Reconta os AVM-pacientes e AVM-Dia por paciente/setor/dia,
    // unindo episódios de admissão sem duplicar dias sobrepostos.
    for (const [sector, keys] of Object.entries(patientsBySector)) {
      const s = ensure(sector);
      s.pacientesAVM = keys.size;
      s.total = keys.size;
    }
    for (const [day, bySector] of Object.entries(avmPatientsByDay)) {
      for (const [sector, keys] of Object.entries(bySector)) {
        const s = ensure(sector);
        s.diasAVM += keys.size;
        daily[day].avm += keys.size;
        if (Object.prototype.hasOwnProperty.call(censoByDay[day], sector)) s.avmDiasTaxa += keys.size;
      }
    }

    const sectors = Object.values(stats).map((s: any) => ({
      setor: s.setor, total: s.total, pacientesAVM: s.pacientesAVM, diasAVM: s.diasAVM,
      mediaAVM: s.pacientesAVM > 0 ? s.diasAVM / s.pacientesAVM : null,
      qtdPacientesAVM: s.pacientesAVM, internadosDia: s.internadosDia,
      diasComCenso: s.diasComCenso,
      totExt: s.totExt, totRetot: s.totRetot, falhas48h: s.falhas48h,
      extAvaliaveis: s.extAvaliaveis, extSucesso: s.extSucesso, extPendentes: s.extPendentes,
      programada: s.programada, autoextubacao: s.autoextubacao, acidental: s.acidental,
      notificadas: s.notificadas,
      txNotificadas: (s.autoextubacao + s.acidental) > 0 ? s.notificadas / (s.autoextubacao + s.acidental) * 100 : null,
      tqt: s.tqt, obitos: s.obitos, desfechos: s.desfechos,
      txUtilizacao: s.internadosDia > 0 ? s.avmDiasTaxa / s.internadosDia * 100 : null,
      txNaoProg: s.totExt > 0 ? (s.autoextubacao + s.acidental) / s.totExt * 100 : 0,
      txSucesso: s.extAvaliaveis > 0 ? s.extSucesso / s.extAvaliaveis * 100 : null,
      txFalha: s.extAvaliaveis > 0 ? s.falhas48h / s.extAvaliaveis * 100 : null,
      txTQT: s.total > 0 ? s.tqt / s.total * 100 : 0,
      txObito: s.total > 0 ? s.obitos / s.total * 100 : 0,
      mediaIOTTQT: s.qtdIOTTQT > 0 ? s.diasIOTTQT / s.qtdIOTTQT : null,
      qtdIOTTQT: s.qtdIOTTQT,
      mediaIOTExt: s.qtdIOTExt > 0 ? s.diasIOTExt / s.qtdIOTExt : null,
      mediaTQTDecanul: s.qtdTQTDecanul > 0 ? s.diasTQTDecanul / s.qtdTQTDecanul : null,
    })).sort((a: any, b: any) => a.setor.localeCompare(b.setor, "pt-BR"));

    const total = sectors.reduce((a: any, s: any) => {
      for (const k of ["total", "pacientesAVM", "diasAVM", "internadosDia", "diasComCenso", "totExt", "totRetot", "falhas48h", "extAvaliaveis", "extSucesso", "extPendentes", "autoextubacao", "acidental", "notificadas", "tqt", "obitos", "qtdIOTTQT", "diasIOTExt", "qtdIOTExt", "diasTQTDecanul", "qtdTQTDecanul"]) a[k] += Number(s[k]) || 0;
      a.diasIOTTQT += (Number(s.mediaIOTTQT) || 0) * (Number(s.qtdIOTTQT) || 0);
      return a;
    }, { total: 0, pacientesAVM: 0, diasAVM: 0, internadosDia: 0, diasComCenso: 0, totExt: 0, totRetot: 0, falhas48h: 0, extAvaliaveis: 0, extSucesso: 0, extPendentes: 0, autoextubacao: 0, acidental: 0, notificadas: 0, tqt: 0, obitos: 0, qtdIOTTQT: 0, diasIOTTQT: 0, diasIOTExt: 0, qtdIOTExt: 0, diasTQTDecanul: 0, qtdTQTDecanul: 0 });
    total.qtdPacientesAVM = total.pacientesAVM;
    total.mediaAVM = total.pacientesAVM > 0 ? total.diasAVM / total.pacientesAVM : null;
    total.txUtilizacao = total.internadosDia > 0 ? sectors.reduce((sum: number, s: any) => sum + (Number(s.txUtilizacao) || 0) * (Number(s.internadosDia) || 0) / 100, 0) / total.internadosDia * 100 : null;
    total.txNaoProg = total.totExt > 0 ? (total.autoextubacao + total.acidental) / total.totExt * 100 : 0;
    total.txNotificadas = (total.autoextubacao + total.acidental) > 0 ? total.notificadas / (total.autoextubacao + total.acidental) * 100 : null;
    total.txSucesso = total.extAvaliaveis > 0 ? total.extSucesso / total.extAvaliaveis * 100 : null;
    total.txFalha = total.extAvaliaveis > 0 ? total.falhas48h / total.extAvaliaveis * 100 : null;
    total.txTQT = total.total > 0 ? total.tqt / total.total * 100 : 0;
    total.txObito = total.total > 0 ? total.obitos / total.total * 100 : 0;
    total.mediaIOTTQT = total.qtdIOTTQT > 0 ? total.diasIOTTQT / total.qtdIOTTQT : null;
    total.mediaIOTExt = total.qtdIOTExt > 0 ? total.diasIOTExt / total.qtdIOTExt : null;
    total.mediaTQTDecanul = total.qtdTQTDecanul > 0 ? total.diasTQTDecanul / total.qtdTQTDecanul : null;
    total.desfechos = sectors.reduce((a: any, s: any) => {
      for (const k of ["ativos", "sucesso", "transferencia", "obitos"]) a[k] += Number(s.desfechos?.[k]) || 0;
      return a;
    }, { ativos: 0, sucesso: 0, transferencia: 0, obitos: 0 });
    const evolucaoDiaria = Object.values(daily);
    return json({ ok: true, dataInicio: startDate, dataFim: endDate, setores, total, evolucaoDiaria });
  } catch (e) {
    console.error("guest-indicators error", e);
    return json({ error: "Falha ao gerar os indicadores agregados." }, 500);
  }
});
