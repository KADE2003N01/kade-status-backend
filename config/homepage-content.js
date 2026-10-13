export const defaultHomepageContent = {
  site: {
    title: 'David KWIZERA | Portfolio',
    description: "Explore David KWIZERA's portfolio, background, skills, projects and professional documents."
  },
  brand: {
    name: 'KADE',
    imageUrl: 'media/bg-removed.png',
    loginLabel: 'Login',
    navigation: [
      { label: 'Home', href: 'index.html' },
      { label: 'About', href: 'src/about.html' },
      { label: 'Background', href: 'src/background.html' },
      { label: 'Skills', href: 'src/skills.html' },
      { label: 'Hobbies', href: 'src/hobbies.html' },
      { label: 'Documents', href: 'src/document.html' },
      { label: 'Contact', href: 'src/contact.html' }
    ]
  },
  hero: {
    visible: true,
    kicker: 'DAVID KWIZERA · COMPUTER SCIENCE',
    title: "I'm a Developer",
    subtitle: 'Computer Science Student | Frontend Developer',
    intro: 'I build responsive, user-friendly web experiences and keep learning how thoughtful software can solve real problems.',
    videoUrl: 'media/kiaglicity.mp4',
    backgroundImageUrl: '',
    buttons: [
      { label: 'Explore my documents', href: 'src/document.html', style: 'primary' },
      { label: 'My background', href: 'src/background.html', style: 'outline' }
    ],
    contactText: 'Have a project or opportunity?',
    contactLabel: "Let's connect",
    contactHref: 'src/contact.html'
  },
  introduction: {
    visible: true,
    eyebrow: 'A LITTLE ABOUT ME',
    titleFirst: 'Curious by nature.',
    titleSecond: 'Developer by choice.',
    body: "I'm David KWIZERA, a Computer Science student at the University of Rwanda. I enjoy turning ideas into clear, useful digital experiences and growing my skills through hands-on projects.",
    linkLabel: 'Get to know me',
    linkHref: 'src/about.html'
  },
  highlights: {
    visible: true,
    eyebrow: 'WHAT I BRING',
    title: 'My focus areas',
    linkLabel: 'Explore my skills',
    linkHref: 'src/skills.html',
    cards: [
      { icon: 'fas fa-graduation-cap', title: 'Education', description: 'BSc Computer Science at University of Rwanda. Strong foundation in algorithms, data structures, databases, and modern software engineering practices.' },
      { icon: 'fas fa-code', title: 'Frontend development', description: 'Experienced in building responsive, user-friendly web interfaces using HTML, CSS, JavaScript, and modern frameworks like React.' },
      { icon: 'fas fa-database', title: 'Backend & databases', description: 'Proficient in Python, Java, and database design with PostgreSQL and MySQL. Building scalable server-side solutions.' },
      { icon: 'fas fa-brain', title: 'AI & machine learning', description: 'Actively exploring artificial intelligence and machine learning applications in modern software development.' },
      { icon: 'fas fa-bullseye', title: 'Problem solving', description: 'Strong algorithmic foundation and competitive programming experience with focus on efficient, elegant solutions.' },
      { icon: 'fas fa-seedling', title: 'Always learning', description: 'Committed to staying updated with emerging technologies and best practices in the tech industry.' }
    ]
  },
  documents: {
    visible: true,
    eyebrow: 'DOCUMENTS & RESOURCES',
    title: 'Need my CV or certificates?',
    description: 'Browse and download the latest documents from the portfolio document center.',
    buttonLabel: 'Visit document center',
    buttonHref: 'src/document.html'
  },
  footer: {
    visible: true,
    brandName: 'KADE',
    tagline: 'Building elegant solutions through code',
    description: 'Computer Science student | Frontend Developer | Problem Solver',
    quickLinksTitle: 'Quick Links',
    servicesTitle: 'Services',
    socialTitle: 'Connect With Me',
    quickLinks: [
      { label: 'Home', href: 'index.html' },
      { label: 'About Me', href: 'src/about.html' },
      { label: 'Background', href: 'src/background.html' },
      { label: 'Skills', href: 'src/skills.html' }
    ],
    services: [
      { label: 'Web Development', href: 'src/skills.html' },
      { label: 'UI/UX Design', href: 'src/skills.html' },
      { label: 'Consulting', href: 'src/background.html' },
      { label: 'Contact', href: 'src/contact.html' }
    ],
    socialLinks: [
      { label: 'GitHub', icon: 'fab fa-github', href: 'https://github.com/KADE2003N01/kade-status' },
      { label: 'LinkedIn', icon: 'fab fa-linkedin', href: 'https://www.linkedin.com/feed/' },
      { label: 'WhatsApp', icon: 'fab fa-whatsapp', href: 'https://wa.me/+250788950833' },
      { label: 'Facebook', icon: 'fab fa-facebook', href: 'https://facebook.com/' }
    ],
    email: 'kadecomputerscience@gmail.com',
    phone: '+250 788 950 833',
    copyright: '© 2026 David KWIZERA. All rights reserved.',
    builtBy: 'Built by KadeTech',
    contactLabel: 'Contact',
    contactHref: 'tel:+250788950833',
    sourceCodeLabel: 'Source Code',
    sourceCodeHref: 'https://github.com/KADE2003N01/kade-status'
  }
};

const MAX_CONTENT_LENGTH = 80_000;
const MAX_ARRAY_LENGTH = 30;
const MAX_STRING_LENGTH = 2_000;

function isSafeAddress(value, isLink) {
  if (!value) return true;
  if (/[\u0000-\u0020\\]/.test(value)) return false;
  if (/^https?:\/\//i.test(value)) return true;
  if (isLink && /^(?:mailto:|tel:)[^\s]+$/i.test(value)) return true;
  if (/^\/(?!\/)/.test(value) || /^\.\.?\//.test(value)) return true;
  return /^[A-Za-z0-9_-]+(?:[./?#][^\s]*)?$/.test(value);
}

function validateAgainstTemplate(value, template, path) {
  if (typeof template === 'string') {
    if (typeof value !== 'string' || value.length > MAX_STRING_LENGTH) {
      throw Object.assign(new Error(`${path} must be text of at most ${MAX_STRING_LENGTH} characters.`), { status: 400 });
    }
    const key = path.split('.').at(-1);
    if (/(?:href|url)$/i.test(key) && !isSafeAddress(value, /href$/i.test(key))) {
        throw Object.assign(new Error(`${path} must be a safe web address or relative path.`), { status: 400 });
    }
    return;
  }

  if (typeof template === 'boolean') {
    if (typeof value !== 'boolean') {
      throw Object.assign(new Error(`${path} must be true or false.`), { status: 400 });
    }
    return;
  }

  if (Array.isArray(template)) {
    if (!Array.isArray(value) || value.length > MAX_ARRAY_LENGTH) {
      throw Object.assign(new Error(`${path} must be a list of at most ${MAX_ARRAY_LENGTH} items.`), { status: 400 });
    }
    for (const [index, item] of value.entries()) {
      validateAgainstTemplate(item, template[0], `${path}[${index}]`);
    }
    return;
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw Object.assign(new Error(`${path} must be an object.`), { status: 400 });
  }
  const expectedKeys = Object.keys(template);
  if (Object.keys(value).length !== expectedKeys.length || expectedKeys.some((key) => !Object.hasOwn(value, key))) {
    throw Object.assign(new Error(`${path} has missing or unexpected fields.`), { status: 400 });
  }
  for (const key of expectedKeys) {
    validateAgainstTemplate(value[key], template[key], `${path}.${key}`);
  }
}

export function validateHomepageContent(content) {
  if (!content || typeof content !== 'object' || Array.isArray(content)) {
    throw Object.assign(new Error('Homepage content must be an object.'), { status: 400 });
  }
  if (JSON.stringify(content).length > MAX_CONTENT_LENGTH) {
    throw Object.assign(new Error('Homepage content must be smaller than 80 KB.'), { status: 400 });
  }
  validateAgainstTemplate(content, defaultHomepageContent, 'content');
  return content;
}
