// Controlled flat-content adaptation of Aceternity Tabs. Original: docs/aceternity/tabs.json.
import { useId } from 'react';
import { motion } from 'motion/react';
export function Tabs({tabs,value,onChange}) {
  const id=useId();
  return <div className="aceternity-tabs" role="group" aria-label="快速筛选">{tabs.map(tab=><button type="button" key={tab.value} aria-pressed={value===tab.value} onClick={()=>onChange(tab.value)} className="filter-tab">
    {value===tab.value && <motion.div layoutId={`clickedbutton-${id}`} transition={{type:'spring',bounce:.2,duration:.4}} className="tab-indicator"/>}<span className="relative">{tab.title}</span>
  </button>)}</div>;
}
