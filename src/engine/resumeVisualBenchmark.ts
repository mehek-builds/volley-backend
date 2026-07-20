import type { ResumeSpec } from '../llm/resumeSpec';
import type { ContactHeader } from './resumeRender';

export interface ResumeVisualBenchmarkCase {
  id: string;
  group: 'sparse' | 'normal' | 'dense';
  spec: ResumeSpec;
  contact: ContactHeader;
  jdText: string;
}

interface BenchmarkConfig {
  id: string;
  group: ResumeVisualBenchmarkCase['group'];
  entries: number;
  bullets: number;
  bulletLength: 'short' | 'medium' | 'long';
  types: Array<'job' | 'project' | 'leadership'>;
  education: 'top' | 'after_experience';
  coursework: number;
  skills: number;
  contact: 'minimal' | 'full' | 'long';
  longOrganization?: boolean;
  longSchool?: boolean;
  longTitle?: boolean;
}

const CONFIGS: BenchmarkConfig[] = [
  { id: '01-sparse-single-job', group: 'sparse', entries: 1, bullets: 3, bulletLength: 'medium', types: ['job'], education: 'top', coursework: 0, skills: 4, contact: 'full' },
  { id: '02-sparse-single-project', group: 'sparse', entries: 1, bullets: 3, bulletLength: 'medium', types: ['project'], education: 'top', coursework: 2, skills: 5, contact: 'full' },
  { id: '03-sparse-single-leadership', group: 'sparse', entries: 1, bullets: 3, bulletLength: 'medium', types: ['leadership'], education: 'top', coursework: 3, skills: 5, contact: 'minimal' },
  { id: '04-sparse-two-short-jobs', group: 'sparse', entries: 2, bullets: 2, bulletLength: 'short', types: ['job'], education: 'top', coursework: 0, skills: 4, contact: 'full' },
  { id: '05-sparse-graduate-layout', group: 'sparse', entries: 2, bullets: 2, bulletLength: 'short', types: ['job', 'project'], education: 'after_experience', coursework: 0, skills: 5, contact: 'full' },
  { id: '06-normal-two-jobs', group: 'normal', entries: 2, bullets: 3, bulletLength: 'medium', types: ['job'], education: 'top', coursework: 3, skills: 8, contact: 'full' },
  { id: '07-normal-job-project', group: 'normal', entries: 2, bullets: 3, bulletLength: 'medium', types: ['job', 'project'], education: 'top', coursework: 4, skills: 8, contact: 'full' },
  { id: '08-normal-job-leadership', group: 'normal', entries: 2, bullets: 3, bulletLength: 'medium', types: ['job', 'leadership'], education: 'top', coursework: 3, skills: 8, contact: 'full' },
  { id: '09-normal-all-sections', group: 'normal', entries: 3, bullets: 2, bulletLength: 'medium', types: ['job', 'project', 'leadership'], education: 'top', coursework: 4, skills: 9, contact: 'full' },
  { id: '10-normal-graduate-order', group: 'normal', entries: 3, bullets: 2, bulletLength: 'medium', types: ['job', 'project'], education: 'after_experience', coursework: 2, skills: 8, contact: 'full' },
  { id: '11-normal-long-name', group: 'normal', entries: 2, bullets: 3, bulletLength: 'medium', types: ['job', 'project'], education: 'top', coursework: 3, skills: 8, contact: 'long' },
  { id: '12-normal-long-organization', group: 'normal', entries: 3, bullets: 2, bulletLength: 'medium', types: ['job'], education: 'top', coursework: 3, skills: 8, contact: 'full', longOrganization: true },
  { id: '13-normal-long-school', group: 'normal', entries: 2, bullets: 3, bulletLength: 'medium', types: ['job', 'leadership'], education: 'top', coursework: 5, skills: 8, contact: 'full', longSchool: true },
  { id: '14-normal-many-skills', group: 'normal', entries: 3, bullets: 2, bulletLength: 'medium', types: ['job', 'project'], education: 'top', coursework: 3, skills: 14, contact: 'full' },
  { id: '15-normal-near-line-limit', group: 'normal', entries: 2, bullets: 3, bulletLength: 'long', types: ['job', 'project'], education: 'top', coursework: 2, skills: 7, contact: 'full' },
  { id: '16-dense-four-jobs', group: 'dense', entries: 4, bullets: 3, bulletLength: 'long', types: ['job'], education: 'top', coursework: 5, skills: 12, contact: 'full' },
  { id: '17-dense-five-entries', group: 'dense', entries: 5, bullets: 3, bulletLength: 'medium', types: ['job', 'project'], education: 'top', coursework: 5, skills: 12, contact: 'full' },
  { id: '18-dense-mixed-sections', group: 'dense', entries: 5, bullets: 3, bulletLength: 'medium', types: ['job', 'project', 'leadership'], education: 'top', coursework: 5, skills: 12, contact: 'full' },
  { id: '19-dense-long-bullets', group: 'dense', entries: 4, bullets: 3, bulletLength: 'long', types: ['job', 'project'], education: 'top', coursework: 4, skills: 10, contact: 'full' },
  { id: '20-dense-long-contact', group: 'dense', entries: 4, bullets: 3, bulletLength: 'medium', types: ['job', 'project'], education: 'top', coursework: 4, skills: 10, contact: 'long' },
  { id: '21-dense-graduate-order', group: 'dense', entries: 4, bullets: 3, bulletLength: 'medium', types: ['job', 'project', 'leadership'], education: 'after_experience', coursework: 4, skills: 10, contact: 'full' },
  { id: '22-dense-coursework', group: 'dense', entries: 4, bullets: 3, bulletLength: 'medium', types: ['job', 'project'], education: 'top', coursework: 9, skills: 10, contact: 'full' },
  { id: '23-dense-skills', group: 'dense', entries: 4, bullets: 3, bulletLength: 'medium', types: ['job', 'project'], education: 'top', coursework: 3, skills: 20, contact: 'full' },
  { id: '24-dense-long-everything', group: 'dense', entries: 5, bullets: 3, bulletLength: 'long', types: ['job', 'project', 'leadership'], education: 'top', coursework: 8, skills: 18, contact: 'long', longOrganization: true, longSchool: true, longTitle: true },
  { id: '25-dense-minimal-margins', group: 'dense', entries: 5, bullets: 3, bulletLength: 'long', types: ['job'], education: 'after_experience', coursework: 6, skills: 15, contact: 'full' },
];

const SKILLS = [
  'TypeScript',
  'React',
  'Node.js',
  'PostgreSQL',
  'Python',
  'AWS',
  'Docker',
  'GraphQL',
  'REST APIs',
  'Data Analysis',
  'Product Strategy',
  'User Research',
  'CI/CD',
  'Kubernetes',
  'Machine Learning',
  'Figma',
  'A/B Testing',
  'Redis',
  'Terraform',
  'Observability',
];

const COURSES = [
  'Algorithms',
  'Data Structures',
  'Database Systems',
  'Operating Systems',
  'Machine Learning',
  'Computer Networks',
  'Software Engineering',
  'Statistics',
  'Human Computer Interaction',
];

const BULLETS = [
  'Built a customer analytics dashboard that reduced weekly reporting time by 35% for 12 operators.',
  'Designed typed APIs and automated release checks across 8 services, cutting failed deployments by 42%.',
  'Analyzed 24,000 onboarding events and shipped experiments that improved activation by 18%.',
  'Led user research with 36 customers and translated findings into a roadmap adopted by 4 teams.',
  'Created a retrieval pipeline processing 2 million records with 99.9% successful scheduled runs.',
  'Optimized database queries and caching, reducing p95 response time from 920ms to 240ms.',
  'Launched an internal workflow used by 140 employees and eliminated 16 hours of manual work weekly.',
  'Implemented monitoring and recovery controls that reduced production incidents by 31% over two quarters.',
  'Developed forecasting models that improved planning accuracy by 22% across 6 regional markets.',
  'Coordinated engineering, design, and operations to deliver a customer migration 3 weeks ahead of schedule.',
];

function expandedBullet(base: string, length: BenchmarkConfig['bulletLength'], seed: number): string {
  if (length === 'short') return base;
  if (length === 'medium') {
    return `${base.slice(0, -1)}, while documenting the workflow for ${seed + 3} teammates.`;
  }
  return `${base.slice(0, -1)}, while documenting rollout decisions, edge cases, and operating procedures for ${seed + 3} teammates across the organization.`;
}

function makeEntry(
  config: BenchmarkConfig,
  index: number,
): ResumeSpec['experience'][number] {
  const type = config.types[index % config.types.length];
  const org =
    config.longOrganization
      ? `International Center for Applied Computing and Responsible Technology ${index + 1}`
      : `${type === 'project' ? 'Project' : type === 'leadership' ? 'Student Organization' : 'Company'} ${index + 1}`;
  return {
    type,
    org,
    title:
      config.longTitle
        ? 'Senior Product Engineering and Applied Machine Learning Intern'
        : type === 'leadership'
          ? 'Program Lead'
          : type === 'project'
            ? 'Builder'
            : 'Software Engineering Intern',
    date_range: `${2023 + (index % 3)} - ${2024 + (index % 3)}`,
    bullets: Array.from({ length: config.bullets }, (_, bulletIndex) =>
      expandedBullet(
        BULLETS[(index * config.bullets + bulletIndex) % BULLETS.length],
        config.bulletLength,
        index + bulletIndex,
      ),
    ),
  };
}

function contactFor(config: BenchmarkConfig): ContactHeader {
  if (config.contact === 'minimal') return { full_name: 'Alex Rivera' };
  if (config.contact === 'long') {
    return {
      full_name: 'Alexandra Gabrielle Rivera-Montgomery',
      email: 'alexandra.rivera.montgomery@example.com',
      phone: '+1 213 555 0199',
      linkedin_url: 'linkedin.com/in/alexandra-rivera-montgomery',
      github_url: 'github.com/alexandra-rivera-montgomery',
      portfolio_url: 'alexandra-rivera-montgomery.dev',
    };
  }
  return {
    full_name: 'Alex Rivera',
    email: 'alex@example.com',
    phone: '+1 213 555 0100',
    linkedin_url: 'linkedin.com/in/alexrivera',
    github_url: 'github.com/alexrivera',
  };
}

function specFor(config: BenchmarkConfig): ResumeSpec {
  return {
    school: config.longSchool
      ? 'University of Southern California Viterbi School of Engineering'
      : 'University of Southern California',
    degree: config.longSchool
      ? 'Bachelor of Science in Computer Science and Business Administration'
      : 'Bachelor of Science in Computer Science',
    grad_date: 'May 2028',
    coursework: COURSES.slice(0, config.coursework).join(', '),
    education_position: config.education,
    experience: Array.from({ length: config.entries }, (_, index) => makeEntry(config, index)),
    skills: SKILLS.slice(0, config.skills),
  };
}

export const RESUME_VISUAL_BENCHMARK: ResumeVisualBenchmarkCase[] = CONFIGS.map((config) => ({
  id: config.id,
  group: config.group,
  spec: specFor(config),
  contact: contactFor(config),
  jdText:
    'Build TypeScript and React products, design reliable APIs, analyze customer data, improve performance, and collaborate across engineering and product teams.',
}));
