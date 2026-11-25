import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getActiveOrganizationId } from '@/lib/active-organization';
import { useOrganizationStore } from '@/lib/stores/organization-store';

const ORG = '11111111-1111-4111-8111-111111111111';
const initial = useOrganizationStore.getState();

function setWorkspace(state: { isPersonalMode: boolean; currentOrganization: { id: string } | null }) {
  useOrganizationStore.setState(state as never);
}

describe('active organization for generation requests', () => {
  afterEach(() => {
    useOrganizationStore.setState({
      isPersonalMode: initial.isPersonalMode,
      currentOrganization: initial.currentOrganization,
    } as never);
  });

  it('returns the organization id in an organization workspace', () => {
    setWorkspace({ isPersonalMode: false, currentOrganization: { id: ORG } });
    expect(getActiveOrganizationId()).toBe(ORG);
  });

  it('returns nothing in personal mode even when an organization is remembered', () => {
    setWorkspace({ isPersonalMode: true, currentOrganization: { id: ORG } });
    expect(getActiveOrganizationId()).toBeUndefined();
  });

  it('returns nothing when no organization is selected', () => {
    setWorkspace({ isPersonalMode: false, currentOrganization: null });
    expect(getActiveOrganizationId()).toBeUndefined();
  });
});

describe('chat-input generation requests', () => {
  const source = readFileSync(join(process.cwd(), 'src/components/ui/chat-input.tsx'), 'utf8');

  function section(startMarker: string, endMarker: string): string {
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return source.slice(start, end);
  }

  it('sends organizationId with the image form data and the image JSON body', () => {
    const image = section("const handleImageGenerate = async", "fetch('/api/generate-image'");
    expect(image).toContain("formData.append('organizationId', activeOrganizationId)");
    expect(image).toContain('jsonData.organizationId = activeOrganizationId');
    expect(image).toContain('getActiveOrganizationId()');
  });

  it('sends organizationId with the video request body', () => {
    const video = section("const handleVideoGenerate = async", "fetch('/api/generate-video'");
    expect(video).toContain('organizationId: getActiveOrganizationId()');
  });
});
