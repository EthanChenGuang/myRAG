import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { requireMultiTenant } from '@/lib/deployment-mode';
import { isPersonalOrganization } from '@/lib/auth/organization-handler';
import { logger } from '@/lib/logger';

/**
 * PATCH /api/organizations/[id]/members/[userId]
 * Update a member's role
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; userId: string }> }
) {
  try {
    requireMultiTenant();
    const { id, userId } = await params;

    const supabase = await createClient();
    const {
      data: { user: authUser },
    } = await supabase.auth.getUser();

    if (!authUser) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Membership rows are hidden from non-owners by RLS, so role checks and writes use the service role
    // once the caller has been verified through getUser.
    const db = getSupabaseAdmin();
    if (!db) {
      logger.error('API', 'Database client is not available');
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }

    const body = await request.json();
    const { role } = body;

    // Validate role
    const validRoles = ['owner', 'admin', 'member', 'viewer'];
    if (!role || !validRoles.includes(role)) {
      return NextResponse.json(
        { error: 'Invalid role. Must be one of: owner, admin, member, viewer' },
        { status: 400 }
      );
    }

    // Check if personal organization
    const isPersonal = await isPersonalOrganization(id);
    if (isPersonal) {
      return NextResponse.json(
        { error: 'Cannot modify personal organization membership' },
        { status: 403 }
      );
    }

    // Verify requester is admin or owner
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

    const requesterIsOwner = requesterMembership.role === 'owner';
    if (role === 'owner' && !requesterIsOwner) {
      return NextResponse.json(
        { error: 'Only an owner can grant the owner role' },
        { status: 403 }
      );
    }

    const { data: targetMember } = await db
      .from('organization_members')
      .select('role')
      .eq('organization_id', id)
      .eq('user_id', userId)
      .single();

    if (!targetMember) {
      return NextResponse.json({ error: 'Member not found' }, { status: 404 });
    }

    if (targetMember.role === 'owner' && !requesterIsOwner) {
      return NextResponse.json(
        { error: 'Only an owner can change an owner' },
        { status: 403 }
      );
    }

    // Prevent removing the last owner
    if (role !== 'owner') {
      if (targetMember.role === 'owner') {
        const { count } = await db
          .from('organization_members')
          .select('*', { count: 'exact', head: true })
          .eq('organization_id', id)
          .eq('role', 'owner');

        if (count === 1) {
          return NextResponse.json(
            { error: 'Cannot change role of the last owner' },
            { status: 403 }
          );
        }
      }
    }

    // Update member role
    const { data: member, error: updateError } = await db
      .from('organization_members')
      .update({ role })
      .eq('organization_id', id)
      .eq('user_id', userId)
      .select()
      .single();

    if (updateError) {
      logger.error('API', `Error updating member role: ${updateError.message}`);
      return NextResponse.json(
        { error: 'Failed to update member role' },
        { status: 500 }
      );
    }

    logger.info('API', `Updated role for user ${userId} in org ${id} to ${role}`);

    return NextResponse.json(member);
  } catch (error: any) {
    logger.error('API', `Error in PATCH /api/organizations/[id]/members/[userId]: ${error.message}`);

    if (error.message.includes('multi-tenant mode')) {
      return NextResponse.json(
        { error: 'This feature requires multi-tenant mode' },
        { status: 403 }
      );
    }

    return NextResponse.json(
      { error: 'Failed to update member' },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/organizations/[id]/members/[userId]
 * Remove a member from an organization
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string; userId: string }> }
) {
  try {
    requireMultiTenant();
    const { id, userId } = await params;

    const supabase = await createClient();
    const {
      data: { user: authUser },
    } = await supabase.auth.getUser();

    if (!authUser) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Membership rows are hidden from non-owners by RLS, so role checks and writes use the service role
    // once the caller has been verified through getUser.
    const db = getSupabaseAdmin();
    if (!db) {
      logger.error('API', 'Database client is not available');
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }

    // Check if personal organization
    const isPersonal = await isPersonalOrganization(id);
    if (isPersonal) {
      return NextResponse.json(
        { error: 'Cannot remove members from personal organizations' },
        { status: 403 }
      );
    }

    // Get member being removed
    const { data: targetMember } = await db
      .from('organization_members')
      .select('role')
      .eq('organization_id', id)
      .eq('user_id', userId)
      .single();

    if (!targetMember) {
      return NextResponse.json(
        { error: 'Member not found' },
        { status: 404 }
      );
    }

    // Verify requester has permission
    const { data: requesterMembership } = await db
      .from('organization_members')
      .select('role')
      .eq('organization_id', id)
      .eq('user_id', authUser.id)
      .single();

    // Users can remove themselves, or admins/owners can remove others
    const isSelf = userId === authUser.id;
    const hasPermission = requesterMembership && ['owner', 'admin'].includes(requesterMembership.role);

    if (!isSelf && !hasPermission) {
      return NextResponse.json(
        { error: 'Insufficient permissions' },
        { status: 403 }
      );
    }

    if (!isSelf && targetMember.role === 'owner' && requesterMembership?.role !== 'owner') {
      return NextResponse.json(
        { error: 'Only an owner can remove an owner' },
        { status: 403 }
      );
    }

    // Prevent removing the last owner
    if (targetMember.role === 'owner') {
      const { count } = await db
        .from('organization_members')
        .select('*', { count: 'exact', head: true })
        .eq('organization_id', id)
        .eq('role', 'owner');

      if (count === 1) {
        return NextResponse.json(
          { error: 'Cannot remove the last owner. Transfer ownership first or delete the organization.' },
          { status: 403 }
        );
      }
    }

    // Remove member
    const { error: deleteError } = await db
      .from('organization_members')
      .delete()
      .eq('organization_id', id)
      .eq('user_id', userId);

    if (deleteError) {
      logger.error('API', `Error removing member: ${deleteError.message}`);
      return NextResponse.json(
        { error: 'Failed to remove member' },
        { status: 500 }
      );
    }

    logger.info('API', `Removed user ${userId} from organization ${id}`);

    return NextResponse.json({ success: true });
  } catch (error: any) {
    logger.error('API', `Error in DELETE /api/organizations/[id]/members/[userId]: ${error.message}`);

    if (error.message.includes('multi-tenant mode')) {
      return NextResponse.json(
        { error: 'This feature requires multi-tenant mode' },
        { status: 403 }
      );
    }

    return NextResponse.json(
      { error: 'Failed to remove member' },
      { status: 500 }
    );
  }
}
