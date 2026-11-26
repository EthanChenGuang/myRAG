'use client';

import { PanelLeft, SquarePen, Ghost } from 'lucide-react';
import { useAuth } from '@/components/providers/auth-provider';
import { ThemeToggle } from './theme-toggle';
import { ShareChatButton } from './share-chat-button';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { TextSizeSlider } from './text-size-slider';
import { useChatStore } from '@/lib/chat-store';
import { useShallow } from 'zustand/react/shallow';
import { UserMenu } from './user-menu';
import { PermanentDocUploadButton } from './permanent-doc-upload-button';
import { MobileToolbarFixed } from './mobile-toolbar-fixed';
import { useState, useEffect } from 'react';
import type { ProcessedDocument } from './permanent-doc-upload-button';
import { useLanguage } from '@/components/providers/language-provider';
import { useAdminStore, useAdmin } from '@/lib/admin-store';
import Image from 'next/image';
import { PortalTooltip } from '@/components/ui/portal-tooltip';
import { WhatsAppConnectionButton } from './whatsapp-connection-button';
import { useGhostModeStore } from '@/lib/ghost-mode-store';

interface HeaderProps {
  onNewChat?: () => void;
  onToggleSidebar: () => void;
  isSidebarOpen?: boolean;
}

export function Header({ onNewChat, onToggleSidebar, isSidebarOpen }: HeaderProps) {
  const { user, isAuthEnabled, signOut } = useAuth();
  const pathname = usePathname();
  const isAuthPage = pathname === '/auth';
  const { currentChatId, chats } = useChatStore(
    useShallow((s) => ({ currentChatId: s.currentChatId, chats: s.chats }))
  );
  const { isGhostMode, toggleGhostMode, hasUnsavedGhostMessages } = useGhostModeStore();
  const [isPermanentDocProcessing, setIsPermanentDocProcessing] = useState(false);
  const [permanentDoc, setPermanentDoc] = useState<ProcessedDocument | null>(null);
  const { t } = useLanguage();

  const { isAdmin } = useAdmin();
  const [headerLogoType, setHeaderLogoType] = useState<string>('text');
  const [headerLogoText, setHeaderLogoText] = useState<string>('myRAG');
  const [headerLogoUrl, setHeaderLogoUrl] = useState<string | null>(null);

  // Show TextSizeSlider whenever there's a current chat (saved or ghost)
  const hasActiveChat = Boolean(currentChatId);

  // Initialize header logo configuration
  useEffect(() => {
    // Load from localStorage first for quick initial render
    const savedLogoType = localStorage.getItem('HEADER_LOGO_TYPE');
    const savedLogoText = localStorage.getItem('HEADER_LOGO_TEXT');
    const savedLogoUrl = localStorage.getItem('HEADER_LOGO_URL');

    if (savedLogoType) setHeaderLogoType(savedLogoType);
    if (savedLogoText) setHeaderLogoText(savedLogoText);
    if (savedLogoUrl) setHeaderLogoUrl(savedLogoUrl);

    // Then fetch latest from server
    async function fetchHeaderConfig() {
      try {
        // Fetch logo type and text
        const typeResponse = await fetch('/api/config/get-env?var=NEXT_PUBLIC_HEADER_LOGO_TYPE');
        if (typeResponse.ok) {
          const typeData = await typeResponse.json();
          if (typeData.value) {
            setHeaderLogoType(typeData.value);
            localStorage.setItem('HEADER_LOGO_TYPE', typeData.value);
          }
        }

        const textResponse = await fetch('/api/config/get-env?var=NEXT_PUBLIC_HEADER_LOGO_TEXT');
        if (textResponse.ok) {
          const textData = await textResponse.json();
          if (textData.value) {
            setHeaderLogoText(textData.value);
            localStorage.setItem('HEADER_LOGO_TEXT', textData.value);
          }
        }

        // Fetch logo URL
        const logoResponse = await fetch('/api/config/get-logo?type=header');
        if (logoResponse.ok) {
          const logoData = await logoResponse.json();
          if (logoData.logoUrl) {
            setHeaderLogoUrl(logoData.logoUrl);
            localStorage.setItem('HEADER_LOGO_URL', logoData.logoUrl);
          }
        }
      } catch (error) {
        console.error('Error fetching header logo config:', error);
      }
    }

    fetchHeaderConfig();
  }, []);

  const handlePermanentDocProcessingStart = (fileName: string) => {
    setIsPermanentDocProcessing(true);
    setPermanentDoc(null);
  };

  const handlePermanentDocProcessingComplete = (processedDoc: ProcessedDocument) => {
    setPermanentDoc(processedDoc);
    setIsPermanentDocProcessing(false);
  };

  const handlePermanentDocProcessingError = (error: Error) => {
    console.error('Permanent document processing error:', error);
    setPermanentDoc(null);
    setIsPermanentDocProcessing(false);
  };

  const handleGhostModeToggle = () => {
    if (!isGhostMode) {
      // Enabling ghost mode - no confirmation needed
      toggleGhostMode();
    } else if (hasUnsavedGhostMessages) {
      // Disabling with unsaved messages - confirm only in this case
      const confirmDisable = window.confirm(
        'Exit Ghost Mode? Current conversation will be cleared and not saved.'
      );
      if (confirmDisable) {
        toggleGhostMode();
      }
    } else {
      // Disabling without messages - no confirmation needed
      toggleGhostMode();
    }
  };

  return (
    <div className={cn(
      "fixed top-0",
      "header-container chat-topbar",
      isSidebarOpen ? "lg:left-64 left-0 right-0" : "left-0 right-0"
    )}
      style={{ zIndex: 60 }}>
      <style jsx global>{`
        /* Header visibility fixes for mobile */
        .header-container {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          z-index: 50; /* Higher z-index to ensure it stays above other elements */
          height: 4rem; /* Explicit height */
          transform: translateZ(0); /* Force hardware acceleration */
          -webkit-transform: translateZ(0);
          will-change: transform; /* Hint for browser optimization */
          transition: transform 0.2s ease;
          background-color: transparent; /* Fully transparent background */
          
          /* Enhanced mobile browser compatibility */
          -webkit-user-select: none;
          -moz-user-select: none;
          user-select: none;
          -webkit-touch-callout: none;
          -webkit-tap-highlight-color: transparent;
          contain: layout style paint;
        }
        
        /* Set header background colors based on theme */
        :root {
          --header-bg-color: transparent;
        }
        
        /* Make header transparent in both light and dark mode */
        .header-container {
          background-color: transparent !important;
        }
        
        /* Ensure header remains visible when keyboard is open */
        .header-container::before {
          content: '';
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          height: 100%;
          z-index: -1;
          backdrop-filter: none;
        }
        
        /* Prevent header from disappearing when keyboard shows */
        @media (max-height: 450px) {
          .header-container {
            position: absolute;
          }
        }
        
        /* Fix for iOS Safari and Chrome */
        @supports (-webkit-touch-callout: none) {
          .header-container {
            position: sticky;
            top: 0;
            z-index: 50;
          }
        }
      `}</style>

      <div className="chat-topbar__row relative flex items-center justify-between h-14 lg:h-16 px-3 sm:px-5 bg-transparent pointer-events-none">
        {/* Desktop Layout (1024px and up) */}
        <div className="hidden lg:flex items-center justify-between w-full">
          <div className="flex items-center gap-2 z-20">
            {!isSidebarOpen && (
              <div className="chat-capsule pointer-events-auto">
                <PortalTooltip content={t('openSidebar')} align="right">
                  <button
                    onClick={onToggleSidebar}
                    className="chat-pill-icon h-9 w-9 group relative"
                  >
                    <PanelLeft className="h-5 w-5" strokeWidth={1.75} aria-hidden="true" />
                    <span className="sr-only">{t('openSidebar')}</span>
                  </button>
                </PortalTooltip>

                {onNewChat && (!isAuthEnabled || user) && (
                  <PortalTooltip content={t('newChat')}>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onNewChat();
                      }}
                      className="chat-pill-icon h-9 w-9 group relative"
                    >
                      <SquarePen className="h-5 w-5" strokeWidth={1.75} aria-hidden="true" />
                      <span className="sr-only">{t('newChat')}</span>
                    </button>
                  </PortalTooltip>
                )}
              </div>
            )}

            <div className="chat-capsule chat-title-capsule pointer-events-auto">
              <span className="chat-title-capsule__label" translate="no">{headerLogoText}</span>
            </div>
          </div>

          <div className="chat-capsule flex items-center gap-0.5 pointer-events-auto z-20">
            <div className="chat-pill-group flex items-center gap-0.5">
              {!isAuthPage && hasActiveChat ? (
                <TextSizeSlider />
              ) : (
                <ThemeToggle />
              )}

              {!isAuthPage && hasActiveChat && (
                <ThemeToggle />
              )}

              {!isAuthPage && (!isAuthEnabled || user) && (
                <>
                  <ShareChatButton />
                  <PermanentDocUploadButton
                    disabled={isPermanentDocProcessing}
                    isActive={Boolean(permanentDoc)}
                    onProcessingStart={handlePermanentDocProcessingStart}
                    onProcessingComplete={handlePermanentDocProcessingComplete}
                    onProcessingError={handlePermanentDocProcessingError}
                    className="chat-pill-icon h-9 w-9 group relative"
                  />
                  <PortalTooltip content={t('useIncognitoChat')}>
                    <button
                      onMouseDown={(e) => {
                        // Prevent the button from stealing focus from the input
                        e.preventDefault();
                      }}
                      onClick={handleGhostModeToggle}
                      className={cn(
                        "chat-pill-icon h-9 w-9 group relative",
                        isGhostMode && "is-ghost-active"
                      )}
                    >
                      <Ghost className="h-5 w-5" strokeWidth={1.75} aria-hidden="true" />
                      <span className="sr-only">{t('useIncognitoChat')}</span>
                    </button>
                  </PortalTooltip>
                </>
              )}
            </div>
            {!isAuthPage && user && (
              <div className="flex items-center">
                <WhatsAppConnectionButton />
              </div>
            )}
            {!isAuthPage && (
              <UserMenu email={user?.email} onSignOut={user ? signOut : undefined} />
            )}
          </div>
        </div>

        {/* Mobile + Tablet Layout (smaller than 1024px): floating glass capsules */}
        <div className="chat-topbar__mobile flex lg:hidden items-center justify-between w-full gap-2">
          <div className="flex items-center gap-2 min-w-0 z-20">
            <div className="chat-capsule chat-capsule--round pointer-events-auto">
              <button
                onClick={onToggleSidebar}
                className="chat-pill-icon h-10 w-10 group relative"
              >
                <PanelLeft className="h-5 w-5" strokeWidth={1.75} aria-hidden="true" />
                <span className="sr-only">{t('openSidebar')}</span>
              </button>
            </div>

            <div className="chat-capsule chat-title-capsule pointer-events-auto min-w-0">
              <span className="chat-title-capsule__label" translate="no">{headerLogoText}</span>
            </div>
          </div>

          {!isAuthPage && (
            <div className="chat-capsule chat-capsule--actions flex items-center pointer-events-auto z-20">
              {(!isAuthEnabled || user) && (
                <MobileToolbarFixed />
              )}
              <UserMenu email={user?.email} onSignOut={user ? signOut : undefined} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
