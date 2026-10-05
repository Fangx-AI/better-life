// Data-driven accessible adaptation of Aceternity Expandable Card Standard.
// Original shared-layout row -> overlay pattern: docs/aceternity/expandable-card-demo-standard.json.
import { useEffect, useRef, useId } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { createPortal } from 'react-dom';
import { IconChevronDown, IconX } from '@tabler/icons-react';
import { NavbarButton } from './resizable-navbar';
import { TracingBeam } from './tracing-beam';
export function ExpandableCards({cards,active,onOpen,onClose,renderContent}) {
  const id=useId(), ref=useRef(null), opener=useRef(null), scrollRef=useRef(null);
  useEffect(()=>{
    if(!active)return;
    opener.current=document.activeElement;
    const old=document.body.style.overflow;document.body.style.overflow='hidden';
    const handle=event=>{
      if(event.key==='Escape')onClose();
      if(event.key==='Tab'){
        const a=[...ref.current.querySelectorAll('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), [tabindex="0"]')],first=a[0],last=a.at(-1);
        if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
        else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
      }
    };
    ref.current?.querySelector('button')?.focus();window.addEventListener('keydown',handle);
    return ()=>{document.body.style.overflow=old;window.removeEventListener('keydown',handle);opener.current?.focus();};
  },[active,onClose]);
  return <><div className="entry-list">{cards.map(card=><motion.article layoutId={`card-${card.id}-${id}`} key={card.id} id={`entry-${card.id}`} className="expandable-row">
    <button className="entry-open" type="button" onClick={()=>onOpen(card)} aria-label={`展开：${card.displayTitle||card.title}`}><span className="entry-icon" aria-hidden="true">{card.icon}</span><span className="entry-copy"><motion.h3 layoutId={`title-${card.id}-${id}`}>{card.displayTitle||card.title}</motion.h3><p>{card.displayDescription||card.summary}</p></span><IconChevronDown className="entry-chevron" size={20} aria-hidden="true"/></button>
  </motion.article>)}</div>{createPortal(<AnimatePresence>{active&&<motion.div className="reader-overlay" initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0}} onClick={e=>{if(e.target===e.currentTarget)onClose();}}>
    <motion.div ref={ref} role="dialog" aria-modal="true" aria-labelledby={`reader-title-${id}`} layoutId={`card-${active.id}-${id}`} className="reader"><div className="reader-toolbar"><span>阅读建议 · 成本、收益和出处</span><NavbarButton as="button" type="button" className="icon-button" variant="secondary" aria-label="关闭阅读" onClick={onClose}><IconX size={24}/></NavbarButton></div><div className="reader-scroll" ref={scrollRef}><TracingBeam className="reader-beam" scrollContainer={scrollRef}><motion.h2 layoutId={`title-${active.id}-${id}`} id={`reader-title-${id}`}>{active.title}</motion.h2>{renderContent(active)}</TracingBeam></div></motion.div>
  </motion.div>}</AnimatePresence>,document.body)}</>;
}
