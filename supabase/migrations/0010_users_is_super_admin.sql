-- ============================================================
-- SAT Exam OS — Migration 0010
-- Super-admin flag on users. Only super admins can invite new admins;
-- otherwise the role hierarchy is unchanged.
-- ============================================================

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_super_admin BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN users.is_super_admin IS
  'When TRUE, this admin can invite/remove other admins. Only meaningful when role = ''admin''. Set via the admin/admins UI by another super admin, or seeded directly in the DB for the first super admin.';

-- Bootstrap: promote the original account owner to super admin so the
-- system has at least one user who can invite others. The match is
-- restricted to role='admin' so a non-admin row sharing the email
-- (shouldn't exist, but defensively) is unaffected.
UPDATE users
SET is_super_admin = TRUE,
    updated_at = NOW()
WHERE email = 'barry.py.chuang01@gmail.com'
  AND role = 'admin'
  AND is_super_admin = FALSE;
