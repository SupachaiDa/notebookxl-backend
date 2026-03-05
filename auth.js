/**
 * auth.js
 * Middleware to verify Supabase JWT and check admin role.
 */

import { createClient } from '@supabase/supabase-js'

let _supabase = null
function getSupabase() {
  if (!_supabase) _supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)
  return _supabase
}

// ── Verify JWT from Authorization header ──────────────────────────────────────
export async function verifyToken(req, res, next) {
  try {
    const authHeader = req.headers.authorization
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or invalid authorization header.' })
    }

    const token    = authHeader.split(' ')[1]
    const supabase = getSupabase()

    const { data: { user }, error } = await supabase.auth.getUser(token)

    if (error || !user) {
      return res.status(401).json({ error: 'Invalid or expired token.' })
    }

    req.user = user   // attach user to request
    next()
  } catch (err) {
    res.status(401).json({ error: 'Authentication failed.' })
  }
}

// ── Check if user is admin ────────────────────────────────────────────────────
export function isAdmin(req, res, next) {
  const adminEmail = process.env.ADMIN_EMAIL
  if (!adminEmail) return res.status(500).json({ error: 'ADMIN_EMAIL not configured.' })
  if (req.user?.email !== adminEmail) {
    return res.status(403).json({ error: 'Admin access required.' })
  }
  next()
}
