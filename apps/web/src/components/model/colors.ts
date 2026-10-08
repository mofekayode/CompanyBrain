// One stable colour per entity type, so the same kind of thing looks the same everywhere.

const FIXED: Record<string, string> = {
  Customer: '#2563eb',
  Site: '#0891b2',
  Asset: '#16a34a',
  'Loaner Unit': '#65a30d',
  Person: '#9333ea',
  Branch: '#db2777',
  Vendor: '#ea580c',
  'Work Order': '#64748b',
  Invoice: '#ca8a04',
  Payment: '#a16207',
  Bill: '#c2410c',
  'PM Agreement': '#0d9488',
  'Labor Rate': '#be123c',
  Vehicle: '#4f46e5',
  'Customer Contact': '#7c3aed',
  'GL Account': '#78716c',
  'Service Item': '#b45309',
  Deal: '#0284c7',
  'CRM Note': '#475569',
}
const PALETTE = ['#2563eb', '#16a34a', '#9333ea', '#db2777', '#ea580c', '#0891b2', '#ca8a04', '#4f46e5', '#0d9488', '#be123c', '#65a30d', '#7c3aed']

export function typeColor(type: string): string {
  if (FIXED[type]) return FIXED[type]
  let h = 0
  for (const c of type) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return PALETTE[h % PALETTE.length]
}
