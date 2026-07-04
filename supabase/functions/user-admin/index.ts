import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const FUNCTION_VERSION = "2026-07-05.2";

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify({ function_version: FUNCTION_VERSION, ...body }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function textValue(value: unknown) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function rawErrorValue(value: unknown) {
  if (!value) return "";
  if (value instanceof Error) return value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return textValue(value);
  }
}

function errorBody(err: unknown) {
  const obj = err && typeof err === "object" ? err as Record<string, unknown> : null;
  const message = obj?.message && obj.message !== "[object Object]"
    ? textValue(obj.message)
    : textValue(err);
  return {
    error: message || "Unknown user-admin error",
    detail: textValue(obj?.details || obj?.detail),
    hint: textValue(obj?.hint),
    code: textValue(obj?.code),
    raw_error: rawErrorValue(err),
  };
}

function staffEmail(employeeNumber: string) {
  return `${String(employeeNumber || "").trim()}@staff.mandina.local`;
}

serve(async req => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  let step = "starting";

  try {
    step = "reading environment";
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = req.headers.get("apikey") || Deno.env.get("SUPABASE_ANON_KEY") || "";
    if (!anonKey) return json({ error: "Missing Supabase anon key." }, 500);
    const serviceKey = Deno.env.get("MANDINA_SERVICE_ROLE_KEY")!;
    if (!serviceKey) {
      return json({
        error: "Missing MANDINA_SERVICE_ROLE_KEY secret.",
        detail: "Add the new Supabase service role secret to Edge Function secrets using the name MANDINA_SERVICE_ROLE_KEY.",
      }, 500);
    }

    const authClient = createClient(supabaseUrl, anonKey);
    const supabase = createClient(supabaseUrl, serviceKey);

    step = "checking current user";
    const auth = req.headers.get("Authorization") || "";
    const jwt = auth.replace("Bearer ", "");
    const { data: userData, error: userError } = await authClient.auth.getUser(jwt);
    if (userError || !userData.user) return json({ error: "Not authenticated.", detail: userError?.message || "" }, 401);

    step = "loading manager profile";
    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("role, active")
      .eq("id", userData.user.id)
      .maybeSingle();
    if (profileError) throw profileError;
    if (String(profile?.role || "").toLowerCase() !== "manager" || profile?.active === false) {
      return json({ error: "Manager access required." }, 403);
    }

    step = "reading request body";
    const body = await req.json();
    const action = String(body.action || "");

    if (action === "create-employee-login") {
      step = "validating create employee login request";
      const employeeId = String(body.employee_id || "");
      const password = String(body.password || "");
      const branchIds = Array.isArray(body.branch_ids)
        ? (body.branch_ids as unknown[]).map(value => String(value || "")).filter(Boolean)
        : [];
      if (!employeeId) return json({ error: "employee_id is required." }, 400);
      if (!/^\d{4,}$/.test(password)) return json({ error: "Password must be at least 4 digits." }, 400);
      if (!branchIds.length) return json({ error: "At least one branch must be selected." }, 400);

      step = "loading employee";
      const { data: employee, error: employeeError } = await supabase
        .from("employees")
        .select("*")
        .eq("id", employeeId)
        .maybeSingle();
      if (employeeError) throw employeeError;
      if (!employee) return json({ error: "Employee not found." }, 404);
      if (employee.active === false) return json({ error: "Employee is inactive." }, 400);

      const email = staffEmail(String(employee.employee_number || ""));
      step = "checking existing profile";
      const { data: existingProfile, error: existingProfileError } = await supabase
        .from("profiles")
        .select("id, email")
        .eq("employee_id", employee.id)
        .maybeSingle();
      if (existingProfileError) throw existingProfileError;

      step = "listing auth users";
      const { data: existingUsers, error: listError } = await supabase.auth.admin.listUsers();
      if (listError) throw listError;
      let authUser = existingProfile?.id
        ? existingUsers.users.find(user => user.id === existingProfile.id)
        : existingUsers.users.find(user => String(user.email || "").toLowerCase() === email.toLowerCase());

      if (authUser) {
        step = "updating auth user";
        const { data: updated, error: updateUserError } = await supabase.auth.admin.updateUserById(authUser.id, {
          email,
          password,
          email_confirm: true,
          user_metadata: {
            full_name: employee.full_name,
            employee_number: employee.employee_number,
            login_type: "employee_number",
          },
        });
        if (updateUserError) throw updateUserError;
        authUser = updated.user;
      } else {
        step = "creating auth user";
        const { data: created, error: createError } = await supabase.auth.admin.createUser({
          email,
          password,
          email_confirm: true,
          user_metadata: {
            full_name: employee.full_name,
            employee_number: employee.employee_number,
            login_type: "employee_number",
          },
        });
        if (createError) throw createError;
        authUser = created.user;
      }
      if (!authUser?.id) return json({ error: "Auth user was not created." }, 500);

      step = "upserting profile";
      const { error: profileUpsertError } = await supabase.from("profiles").upsert({
        id: authUser.id,
        full_name: employee.full_name,
        email,
        role: "staff",
        login_type: "employee_number",
        employee_id: employee.id,
        employee_number: employee.employee_number,
        branch_id: branchIds[0] || employee.branch_id,
        branch_ids: branchIds,
        active: true,
        updated_at: new Date().toISOString(),
      });
      if (profileUpsertError) throw profileUpsertError;

      return json({
        created: true,
        user_id: authUser.id,
        employee_id: employee.id,
        employee_number: employee.employee_number,
      });
    }

    return json({ error: "Unknown action." }, 400);
  } catch (err) {
    try {
      const body = errorBody(err);
      return json({
        ...body,
        detail: body.detail || `Failed while ${step}.`,
        step,
      }, 500);
    } catch (formatError) {
      return json({
        error: "User admin failed and the error could not be formatted.",
        detail: `${textValue(formatError)} while ${step}.`,
        step,
      }, 500);
    }
  }
});
