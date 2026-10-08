/**
 * Every image, GIF and video on the site, in one place.
 *
 * Drop the file in `public/media/` and set `src` (e.g. '/media/hero-demo.mp4').
 * Until then the slot renders a labelled placeholder at the right aspect ratio,
 * or the coded product mock where one exists.
 */
export type MediaKind = 'video' | 'image' | 'gif'

export type MediaSlot = {
  kind: MediaKind
  src?: string
  poster?: string
  alt: string
  /** What should go here, shown on the placeholder. */
  brief: string
  aspect: `${number}/${number}`
}

const slots = {
  heroDemo: {
    kind: 'video',
    alt: 'Company Brain product walkthrough',
    brief: '60–90s product walkthrough: ask a question, get a cited answer, open the source.',
    aspect: '16/10',
  },
  demoWalkthrough: {
    kind: 'video',
    alt: 'Full Company Brain demo on a sample acquired company',
    brief: 'Full demo walkthrough on the demo company (4–6 min), with chapters below.',
    aspect: '16/9',
  },
  onsiteInterview: {
    kind: 'image',
    alt: 'An engineer interviewing an operations lead on the shop floor',
    // Not shown yet. After the first engagement, a real (unstaged) onsite photo goes in stage 04. No stock photos.
    brief: 'Real onsite photo from an engagement, e.g. walking the floor with the owner. Caption: “Onsite during a seller transition.”',
    aspect: '4/3',
  },
  physicalRecords: {
    kind: 'image',
    alt: 'Paper binders, equipment labels and a whiteboard being captured',
    brief: 'Photo or GIF: paper files, labels or a handwritten SOP being captured.',
    aspect: '4/3',
  },
  videoTimestamp: {
    kind: 'gif',
    alt: 'An answer that jumps to the exact moment in a training video',
    brief: 'GIF: citation click → video opens at 0:50 where the fact is said.',
    aspect: '16/10',
  },
} satisfies Record<string, MediaSlot>

export const media: Record<keyof typeof slots, MediaSlot> = slots
