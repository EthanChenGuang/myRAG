import { DollarSign, Database, BarChart, Rocket, FileText, Globe, ListTodo, Paintbrush } from 'lucide-react';
import { SuggestionButtonsClient } from './suggestion-buttons-client';

interface SuggestionItem {
  id?: string;
  text: string;
}

interface SuggestionGroup {
  id?: string;
  label: string;
  icon: string;
  items: SuggestionItem[];
}

interface SuggestionButtonsProps {
  onSuggestionClick: (category: string, item: string) => void;
}

// Icon mapping for dynamic icon loading
const iconMap: Record<string, React.ComponentType<{ className?: string }>> = {
  DollarSign,
  Database,
  BarChart,
  Rocket,
  FileText,
  Globe,
  ListTodo,
  Paintbrush,
  Search: FileText, // Fallback
  Heart: FileText, // Fallback
  Star: FileText, // Fallback
  MessageCircle: FileText // Fallback
};

// Default suggestion groups as fallback
const defaultSuggestionGroups: SuggestionGroup[] = [
  {
    label: "Pricing & Ownership",
    icon: "DollarSign",
    items: [
      { text: "How much does myRAG cost?" },
      { text: "How many chatbots can I create?" },
      { text: "Do I own the code forever?" },
      { text: "Can I use myRAG for client projects?" }
    ]
  },
  {
    label: "Technical Foundation",
    icon: "Database",
    items: [
      { text: "What vector database does myRAG use?" },
      { text: "How does myRAG parse documents?" },
      { text: "What AI models does myRAG support?" },
      { text: "How fast is the vector search?" }
    ]
  },
  {
    label: "myRAG vs Others",
    icon: "BarChart",
    items: [
      { text: "How does myRAG compare to Chatbase?" },
      { text: "Why choose myRAG over building from scratch?" },
      { text: "Who created myRAG?" },
      { text: "What features does myRAG have that competitors don't?" }
    ]
  },
  {
    label: "Key Features",
    icon: "Rocket",
    items: [
      { text: "How can I install myRAG?" },
      { text: "How can I deploy myRAG to Vercel?" },
      { text: "Does myRAG support WhatsApp?" },
      { text: "Can I monetize chatbots with Stripe?" }
    ]
  }
];

export function SuggestionButtonsServer({ onSuggestionClick }: SuggestionButtonsProps) {
  // Load configuration from environment variable at build/request time
  let suggestionGroups = defaultSuggestionGroups;
  
  try {
    const suggestionGroupsJson = process.env.NEXT_PUBLIC_SUGGESTION_GROUPS || '';
    if (suggestionGroupsJson) {
      const config = JSON.parse(suggestionGroupsJson);
      if (config.groups && Array.isArray(config.groups)) {
        suggestionGroups = config.groups;
      }
    }
  } catch (error) {
    console.error('Error parsing suggestion groups:', error);
    // Fall back to default groups
  }

  // Transform icon strings to components
  const groupsWithIcons = suggestionGroups.map((group) => {
    const IconComponent = iconMap[group.icon] || FileText;
    return {
      ...group,
      iconComponent: <IconComponent className="h-5 w-5" />
    };
  });

  return (
    <SuggestionButtonsClient 
      suggestionGroups={groupsWithIcons} 
      onSuggestionClick={onSuggestionClick}
    />
  );
}
