// Edge Function: admin-users
// Implantar no MESMO projeto Supabase usado pelo site: osgvhdgnnoxnvtyccwtu
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return reply({ error: "Método não permitido." }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return reply({ error: "Configuração do servidor incompleta: faltam variáveis do Supabase." }, 500);
  }

  const authHeader = req.headers.get("Authorization");
  const token = authHeader?.replace(/^Bearer\s+/i, "");
  if (!token) return reply({ error: "Sessão ausente. Entre novamente no sistema." }, 401);

  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Nunca confiar em perfil enviado pelo navegador: validar token e perfil no banco.
  const { data: authData, error: authError } = await adminClient.auth.getUser(token);
  if (authError || !authData.user) return reply({ error: "Sessão inválida ou expirada. Entre novamente." }, 401);

  const { data: callerProfile, error: profileError } = await adminClient
    .from("perfis_usuarios")
    .select("id, perfil, ativo")
    .eq("id", authData.user.id)
    .maybeSingle();

  if (profileError) return reply({ error: "Não foi possível validar seu perfil administrativo." }, 500);
  if (!callerProfile || callerProfile.ativo !== true || callerProfile.perfil !== "administrador") {
    return reply({ error: "Apenas um administrador ativo pode gerenciar usuários." }, 403);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return reply({ error: "Corpo da solicitação inválido." }, 400);
  }

  const action = String(body.action || "");

  if (action === "list") {
    const { data: profiles, error } = await adminClient
      .from("perfis_usuarios")
      .select("id,nome,perfil,ativo,unidade_id")
      .order("nome", { ascending: true });

    if (error) return reply({ error: "Erro ao consultar perfis: " + error.message }, 500);

    const users = [];
    for (const profile of profiles || []) {
      const { data: authResult } = await adminClient.auth.admin.getUserById(profile.id);
      users.push({
        id: profile.id,
        nome: profile.nome || "",
        email: authResult?.user?.email || "",
        perfil: profile.perfil || "",
        ativo: profile.ativo === true,
        unidade_id: profile.unidade_id ?? null,
        created_at: authResult?.user?.created_at || null,
      });
    }
    return reply({ users });
  }

  if (action === "create") {
    const nome = String(body.nome || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    const senha = String(body.senha || "");
    const perfil = String(body.perfil || "");
    const allowedProfiles = new Set([
      "administrador",
      "coordenacao",
      "fisioterapeuta_plantonista",
      "fisioterapeuta_lider",
      "convidado",
    ]);

    if (!nome || !email || !senha || !perfil) {
      return reply({ error: "Informe nome, e-mail, senha e perfil." }, 400);
    }
    if (senha.length < 8) return reply({ error: "A senha deve ter pelo menos 8 caracteres." }, 400);
    if (!allowedProfiles.has(perfil)) return reply({ error: "Perfil de acesso inválido." }, 400);

    const { data: created, error: createError } = await adminClient.auth.admin.createUser({
      email,
      password: senha,
      email_confirm: true,
      user_metadata: { nome },
    });
    if (createError || !created.user) {
      return reply({ error: createError?.message || "Não foi possível criar a conta de autenticação." }, 400);
    }

    const { error: insertError } = await adminClient.from("perfis_usuarios").insert({
      id: created.user.id,
      nome,
      perfil,
      ativo: true,
    });

    if (insertError) {
      // Evita deixar uma conta criada sem perfil de autorização.
      await adminClient.auth.admin.deleteUser(created.user.id);
      return reply({ error: "A conta foi criada, mas o perfil não pôde ser salvo: " + insertError.message }, 500);
    }

    return reply({
      user: {
        id: created.user.id,
        nome,
        email: created.user.email || email,
        perfil,
        ativo: true,
        created_at: created.user.created_at,
      },
    }, 201);
  }

  if (action === "delete") {
    const userId = String(body.user_id || "");
    if (!userId) return reply({ error: "Informe o usuário a excluir." }, 400);
    if (userId === authData.user.id) return reply({ error: "Não é permitido excluir a própria conta conectada." }, 400);

    const { error: deleteProfileError } = await adminClient.from("perfis_usuarios").delete().eq("id", userId);
    if (deleteProfileError) return reply({ error: "Não foi possível excluir o perfil: " + deleteProfileError.message }, 500);

    const { error: deleteAuthError } = await adminClient.auth.admin.deleteUser(userId);
    if (deleteAuthError) return reply({ error: "O perfil foi removido, mas a conta de autenticação não pôde ser excluída: " + deleteAuthError.message }, 500);

    return reply({ success: true });
  }

  return reply({ error: "Ação não reconhecida." }, 400);
});
