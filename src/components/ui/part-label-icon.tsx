import { FileText, Globe, Lightbulb, type LucideIcon } from 'lucide-react';
import type { PartLabelKey } from '@/lib/chat/part-labels';

/** UI-SPEC 6.6: the leading icon of each labelled answer part. */
export const PART_LABEL_ICONS: Readonly<Record<PartLabelKey, LucideIcon>> = {
  from_documents: FileText,
  from_web: Globe,
  general_knowledge: Lightbulb,
};
