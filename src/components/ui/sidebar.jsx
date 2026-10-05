// Adapted from Aceternity UI's public sidebar registry. Snapshot: docs/aceternity/sidebar.json.
// Reading-page adaptation: a fixed-width desktop directory and one accessible mobile
// disclosure, rather than duplicated children, hover collapse, or an icon-only overlay.
import { createContext, useContext, useId, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { IconList, IconX } from '@tabler/icons-react';
import { cn } from '@/lib/utils';

const SidebarContext = createContext(null);

export function useSidebar() {
  const context = useContext(SidebarContext);
  if (!context) throw new Error('useSidebar must be used within a SidebarProvider');
  return context;
}

export function SidebarProvider({ children, open: openProp, setOpen: setOpenProp, animate = true }) {
  const [openState, setOpenState] = useState(false);
  return <SidebarContext.Provider value={{ open: openProp ?? openState, setOpen: setOpenProp ?? setOpenState, animate }}>{children}</SidebarContext.Provider>;
}

export function Sidebar({ children, open, setOpen, animate }) {
  return <SidebarProvider open={open} setOpen={setOpen} animate={animate}>{children}</SidebarProvider>;
}

export function SidebarBody({ children, className, toggleLabel = '章节目录', ...props }) {
  const { open, setOpen } = useSidebar(), id = useId(), trigger = useRef(null);
  return <motion.aside className={cn('aceternity-reading-sidebar', className)} {...props} onKeyDown={event => {
    if (event.key === 'Escape' && open) { event.preventDefault(); setOpen(false); trigger.current?.focus(); }
  }}>
    <button ref={trigger} className="reading-sidebar-toggle" type="button" aria-expanded={open} aria-controls={`sidebar-${id}`} onClick={() => setOpen(value => !value)}>
      <IconList size={19} aria-hidden="true"/><span>{toggleLabel}</span>{open ? <><small>收起</small><IconX size={18} aria-hidden="true"/></> : <small>展开</small>}
    </button>
    <div id={`sidebar-${id}`} className={cn('reading-sidebar-content', open && 'is-open')}>{children}</div>
  </motion.aside>;
}

export function SidebarLink({ link, className, children, ...props }) {
  const { open, animate } = useSidebar();
  return <a href={link.href} className={cn('reading-sidebar-link', className)} {...props}>
    {link.icon}<motion.span animate={{ opacity: animate ? (open ? 1 : 0) : 1 }} className="reading-sidebar-label">{link.label}</motion.span>{children}
  </a>;
}
