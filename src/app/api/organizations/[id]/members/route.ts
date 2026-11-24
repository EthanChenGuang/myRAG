import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { requireMultiTenant } from '@/lib/deployment-mode';
import { isPersonalOrganization } from '@/lib/auth/organization-handler';
import { logger } from '@/lib/logger';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/organizations/[id]/members
 * List all members of an organization
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    requireMultiTenant();

    const supabase = await createClient();
    const {
      data: { user: authUser },
    } = await supabase.auth.getUser();

    if (!authUser) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Await params before accessing properties (Next.js 15+ requirement)
    const { id } = await params;

    // Membership rows are hidden from non-owners by RLS, so the membership check and the list read use the
    // service role once the caller has been verified through getUser.
    const db = getSupabaseAdmin();
    if (!db) {
      logger.error('API', 'Database client is not available');
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }

    const { data: userMembership } = await db
      .from('organization_members')
      .select('role')
      .eq('organization_id', id)
      .eq('user_id', authUser.id)
      .single();

    if (!userMembership) {
      return NextResponse.json(
        { error: 'Organization not found or access denied' },
        { status: 404 }
      );
    }

    const { data: members, error } = await db
      .from('organization_members')
      .select('id, role, created_at, user_id')
      .eq('organization_id', id);

    if (error || !members) {
      logger.error('API', `Error fetching members: ${error?.message}`);
      return NextResponse.json(
        { error: 'Failed to fetch members' },
        { status: 500 }
      );
    }

    const profiles = await Promise.all(
      members.map(async (m: { user_id: string }) => {
        try {
          const { data } = await db.auth.admin.getUserById(m.user_id);
          return data?.user ?? null;
        } catch {
          return null;
        }
      })
    );

    // Format response
    const formattedMembers = members.map((m: any, index: number) => {
      const profile = profiles[index];
      return {
        id: m.id,
        user_id: m.user_id,
        role: m.role,
        email: profile?.email,
        name: profile?.user_metadata?.full_name || profile?.user_metadata?.name,
        created_at: m.created_at,
      };
    });

    return NextResponse.json(formattedMembers);
  } catch (error: any) {
    logger.error('API', `Error in GET /api/organizations/[id]/members: ${error.message}`);

    if (error.message.includes('multi-tenant mode')) {
      return NextResponse.json(
        { error: 'This feature requires multi-tenant mode' },
        { status: 403 }
      );
    }

    return NextResponse.json(
      { error: 'Failed to fetch members' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/organizations/[id]/members
 * Add a member to an organization (accepts invitation)
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    requireMultiTenant();

    const supabase = await createClient();
    const {
      data: { user: authUser },
    } = await supabase.auth.getUser();

    if (!authUser) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Await params before accessing properties (Next.js 15+ requirement)
    const { id } = await params;

    let body: { user_id?: unknown; role?: unknown };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const { user_id, role = 'member' } = body ?? {};

    if (typeof user_id !== 'string' || !UUID_PATTERN.test(user_id)) {
      return NextResponse.json({ error: 'user_id must be a valid user id' }, { status: 400 });
    }

    const validRoles = ['owner', 'admin', 'member', 'viewer'];
    if (typeof role !== 'string' || !validRoles.includes(role)) {
      return NextResponse.json(
        { error: 'Invalid role. Must be one of: owner, admin, member, viewer' },
        { status: 400 }
      );
    }

    const isPersonal = await isPersonalOrganization(id);
    if (isPersonal) {
      return NextResponse.json(
        { error: 'Cannot add members to personal organizations' },
        { status: 403 }
      );
    }

    // Membership rows are hidden from non-owners by RLS and member INSERT is owner-only, so the role check
    // and the write use the service role once the caller has been verified through getUser.
    const db = getSupabaseAdmin();
    if (!db) {
      logger.error('API', 'Database client is not available');
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }

    const { data: requesterMembership } = await db
      .from('organization_members')
      .select('role')
      .eq('organization_id', id)
      .eq('user_id', authUser.id)
      .single();

    if (!requesterMembership || !['owner', 'admin'].includes(requesterMembership.role)) {
      return NextResponse.json(
        { error: 'Insufficient permissions' },
        { status: 403 }
      );
    }

    if (role === 'owner' && requesterMembership.role !== 'owner') {
      return NextResponse.json(
        { error: 'Only an owner can grant the owner role' },
        { status: 403 }
      );
    }

    const { data: targetUser, error: targetUserError } = await db.auth.admin.getUserById(user_id);
    if (targetUserError || !targetUser?.user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    const { data: existingMember } = await db
      .from('organization_members')
      .select('role')
      .eq('organization_id', id)
      .eq('user_id', user_id)
      .single();

    if (existingMember) {
      return NextResponse.json(
        { error: 'User is already a member of this organization' },
        { status: 409 }
      );
    }

    const { data: org } = await db
      .from('organizations')
      .select('max_team_members')
      .eq('id', id)
      .single();

    if (org) {
      const { count } = await db
        .from('organization_members')
        .select('*', { count: 'exact', head: true })
        .eq('organization_id', id);

      if (count !== null && count >= org.max_team_members) {
        return NextResponse.json(
          { error: 'Organization member limit reached. Please upgrade your plan.' },
          { status: 403 }
        );
      }
    }

    const { data: member, error: memberError } = await db
      .from('organization_members')
      .insert({
        organization_id: id,
        user_id,
        role,
      })
      .select()
      .single();

    if (memberError) {
      if (memberError.code === '23505') {
        return NextResponse.json(
          { error: 'User is already a member of this organization' },
          { status: 409 }
        );
      }

      logger.error('API', `Error adding member: ${memberError.message}`);
      return NextResponse.json(
        { error: 'Failed to add member' },
        { status: 500 }
      );
    }

    logger.info('API', `Added user ${user_id} to organization ${id}`);

    return NextResponse.json(member, { status: 201 });
  } catch (error: any) {
    logger.error('API', `Error in POST /api/organizations/[id]/members: ${error.message}`);

    if (error.message.includes('multi-tenant mode')) {
      return NextResponse.json(
        { error: 'This feature requires multi-tenant mode' },
        { status: 403 }
      );
    }

    return NextResponse.json(
      { error: 'Failed to add member' },
      { status: 500 }
    );
  }
}
