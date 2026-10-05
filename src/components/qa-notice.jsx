import { IconChevronDown } from '@tabler/icons-react';
import { readerText } from '../lib/reader-text.mjs';
import { qaNoticeParts } from '../../shared/qa-notice.mjs';
import '../qa-polish.css';

export function QaNotice({ value }) {
  const { primary, extra } = qaNoticeParts(readerText(value || ''));
  if (!primary) return null;
  return <div className="qa-notice"><p>{primary}</p>{extra && <details className="qa-notice-extra"><summary>补充条件 <IconChevronDown size={15} aria-hidden="true"/></summary><p>{extra}</p></details>}</div>;
}
