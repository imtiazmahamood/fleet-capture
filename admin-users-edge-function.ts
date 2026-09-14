// Supabase Edge Function: admin-users
// Lets a logged-in admin create / update / delete / enable / disable ANY user login
// (admin or driver) without it disturbing the admin's own session (the risky part of
// doing this from a plain browser client).
// Deploy via: Supabase dashboard -> Edge Functions -> admin-users -> replace code -> Deploy

import { createClient } from 'jsr:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req) => {
  // Browsers send an OPTIONS preflight before the real POST -- must answer it or every call gets blocked.
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    if (req.method !== 'POST') {
      return json({ error: 'Method not allowed' }, 405)
    }

    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return json({ error: 'Missing Authorization header' }, 401)
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

    // Verify the caller is actually a logged-in admin before doing anything privileged
    const callerClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } }
    })
    const { data: { user }, error: userErr } = await callerClient.auth.getUser()
    if (userErr || !user) {
      return json({ error: 'Not authenticated' }, 401)
    }
    const { data: callerProfile } = await callerClient.from('profiles').select('role').eq('id', user.id).single()
    if (!callerProfile || callerProfile.role !== 'admin') {
      return json({ error: 'Admins only' }, 403)
    }

    const body = await req.json()
    const action = body.action
    const admin = createClient(supabaseUrl, serviceKey)

    // Guard against locking everyone out: refuse to demote/disable/delete the last active admin.
    async function countOtherActiveAdmins(excludeId: string) {
      const { count } = await admin.from('profiles')
        .select('id', { count: 'exact', head: true })
        .eq('role', 'admin').eq('status', 'Active').neq('id', excludeId)
      return count || 0
    }

    if (action === 'create') {
      const { name, username, password, contact, assignedVehicleReg, status, role } = body
      if (!name || !username || !password) {
        return json({ error: 'name, username and password are required' }, 400)
      }
      const finalRole = role === 'admin' ? 'admin' : 'driver'
      const email = `${String(username).toLowerCase()}@fleetcapture.local`
      const { data: created, error } = await admin.auth.admin.createUser({
        email, password, email_confirm: true,
        user_metadata: { name, role: finalRole }
      })
      if (error) return json({ error: error.message }, 400)

      const { error: profErr } = await admin.from('profiles').update({
        name, role: finalRole, contact: contact || null,
        assigned_vehicle_reg: finalRole === 'driver' ? (assignedVehicleReg || null) : null,
        status: status || 'Active'
      }).eq('id', created.user!.id)
      if (profErr) return json({ error: 'User created but profile update failed: ' + profErr.message }, 500)

      if (finalRole === 'driver' && assignedVehicleReg) {
        const { error: vehErr } = await admin.from('vehicles').update({ driver: name }).eq('reg', assignedVehicleReg)
        if (vehErr) return json({ error: 'User created but vehicle link failed: ' + vehErr.message }, 500)
      }
      return json({ ok: true, id: created.user!.id })
    }

    if (action === 'update') {
      const { id, name, password, contact, assignedVehicleReg, status, role } = body
      if (!id) return json({ error: 'id is required' }, 400)

      const { data: existing } = await admin.from('profiles').select('role,status').eq('id', id).single()
      if (!existing) return json({ error: 'User not found' }, 404)

      const finalRole = role === 'admin' ? 'admin' : (role === 'driver' ? 'driver' : existing.role)
      const finalStatus = status || existing.status || 'Active'

      // If this change would remove admin rights or disable an admin, make sure another active admin remains.
      const losingAdmin = existing.role === 'admin' && (finalRole !== 'admin' || finalStatus !== 'Active')
      if (losingAdmin) {
        const others = await countOtherActiveAdmins(id)
        if (others === 0) return json({ error: 'Cannot remove the last active admin. Create another admin first.' }, 400)
      }

      if (password) {
        const { error } = await admin.auth.admin.updateUserById(id, { password })
        if (error) return json({ error: error.message }, 400)
      }
      const { error: profErr } = await admin.from('profiles').update({
        name, role: finalRole, contact: contact || null,
        assigned_vehicle_reg: finalRole === 'driver' ? (assignedVehicleReg || null) : null,
        status: finalStatus
      }).eq('id', id)
      if (profErr) return json({ error: 'Profile update failed: ' + profErr.message }, 500)
      if (finalRole === 'driver' && assignedVehicleReg && name) {
        const { error: vehErr } = await admin.from('vehicles').update({ driver: name }).eq('reg', assignedVehicleReg)
        if (vehErr) return json({ error: 'Vehicle link failed: ' + vehErr.message }, 500)
      }
      return json({ ok: true })
    }

    if (action === 'delete') {
      const { id } = body
      if (!id) return json({ error: 'id is required' }, 400)
      const { data: existing } = await admin.from('profiles').select('role').eq('id', id).single()
      if (existing && existing.role === 'admin') {
        const others = await countOtherActiveAdmins(id)
        if (others === 0) return json({ error: 'Cannot delete the last active admin. Create another admin first.' }, 400)
      }
      const { error } = await admin.auth.admin.deleteUser(id)
      if (error) return json({ error: error.message }, 400)
      return json({ ok: true })
    }

    return json({ error: 'Unknown action' }, 400)
  } catch (e) {
    return json({ error: String(e) }, 500)
  }
})
