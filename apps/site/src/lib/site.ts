export const site = {
  name: 'Company Brain',
  description:
    'You bought the company. We help you learn how it actually works: we capture institutional knowledge during the seller transition and leave you with a secure, living Company Brain.',
  // TODO: replace with the real inbox before launch. The contact form opens a mail draft to it.
  contactEmail: 'hello@companybrain.example',
  nav: [
    { href: '/#how-it-works', label: 'How it works' },
    { href: '/#what-you-get', label: 'What you get' },
    { href: '/security', label: 'Security' },
    { href: '/demo', label: 'Demo' },
  ],
  cta: { href: '/contact', label: 'Talk about your transition' },
} as const
