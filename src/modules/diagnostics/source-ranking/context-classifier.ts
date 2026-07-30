import type {
  DiagnosticContext,
  ResearchContext,
  SourceRankingCandidateSnapshot,
  SpeciesContext
} from "./types";

type EvidenceRule<T extends string> = {
  value: T;
  terms: readonly string[];
};

const EXPLICIT_CROSS_SPECIES_TERMS = [
  "cross species",
  "cross-species",
  "comparative genomics",
  "multi species",
  "multi-species",
  "interspecies"
] as const;

const SPECIES_RULES: Array<EvidenceRule<Exclude<SpeciesContext, "cross_species" | "unknown">>> = [
  {
    value: "human",
    terms: ["human", "humans", "patient", "patients", "clinical cohort", "participant", "participants"]
  },
  {
    value: "livestock",
    terms: [
      "livestock", "cattle", "bovine", "cow", "cows", "pig", "pigs", "swine", "porcine",
      "sheep", "ovine", "goat", "caprine", "chicken", "poultry", "horse", "equine"
    ]
  },
  {
    value: "model_organism",
    terms: [
      "mouse", "mice", "murine", "rat", "rats", "zebrafish", "drosophila", "fruit fly",
      "c elegans", "caenorhabditis elegans", "xenopus", "yeast", "saccharomyces"
    ]
  },
  {
    value: "plant",
    terms: [
      "plant", "plants", "crop", "crops", "arabidopsis", "rice", "maize", "wheat", "soybean",
      "barley", "sorghum"
    ]
  }
];

const RESEARCH_RULES: Array<EvidenceRule<ResearchContext>> = [
  {
    value: "method",
    terms: [
      "method", "algorithm", "framework", "pipeline", "model architecture", "machine learning",
      "deep learning", "benchmark", "workflow", "software"
    ]
  },
  {
    value: "resource",
    terms: [
      "resource", "database", "atlas", "catalog", "repository", "dataset", "data portal", "reference panel"
    ]
  },
  {
    value: "breeding",
    terms: [
      "breeding", "genomic selection", "genomic prediction", "animal improvement", "crop improvement",
      "selection response", "estimated breeding value"
    ]
  },
  {
    value: "evolution",
    terms: [
      "evolution", "evolutionary", "phylogeny", "phylogenetic", "adaptation", "natural selection",
      "comparative genomics", "conservation"
    ]
  },
  {
    value: "disease",
    terms: [
      "disease", "cancer", "tumor", "tumour", "syndrome", "disorder", "pathogenesis", "pathogenic",
      "infection", "infectious", "diagnosis", "diagnostic", "therapy", "therapeutic", "patient", "patients"
    ]
  },
  {
    value: "basic_biology",
    terms: [
      "mechanism", "development", "developmental", "cell biology", "molecular biology", "gene regulation",
      "chromatin", "transcription", "translation", "signaling", "metabolism", "physiology"
    ]
  }
];

export function classifyDiagnosticContext(
  candidate: Pick<
    SourceRankingCandidateSnapshot,
    "title" | "abstractNote" | "researchCategory"
  >
): DiagnosticContext {
  const normalized = normalize(`${candidate.title ?? ""} ${candidate.abstractNote ?? ""}`);
  const explicitCrossSpecies = matchingTerms(normalized, EXPLICIT_CROSS_SPECIES_TERMS);
  const speciesMatches = SPECIES_RULES.map((rule) => ({
    value: rule.value,
    evidence: matchingTerms(normalized, rule.terms)
  })).filter((match) => match.evidence.length > 0);

  let speciesContext: SpeciesContext = "unknown";
  let speciesEvidence: string[] = [];
  if (explicitCrossSpecies.length > 0 || speciesMatches.length >= 2) {
    speciesContext = "cross_species";
    speciesEvidence = unique([
      ...explicitCrossSpecies,
      ...speciesMatches.flatMap((match) => match.evidence)
    ]);
  } else if (speciesMatches[0]) {
    speciesContext = speciesMatches[0].value;
    speciesEvidence = speciesMatches[0].evidence;
  }

  const categoryContext = categoryToResearchContext(candidate.researchCategory);
  const researchMatches = RESEARCH_RULES.map((rule) => ({
    value: rule.value,
    evidence: matchingTerms(normalized, rule.terms)
  })).filter((match) => match.evidence.length > 0);
  const preferredMatch = categoryContext
    ? researchMatches.find((match) => match.value === categoryContext)
    : undefined;
  const substantiveMatch = researchMatches.find((match) =>
    match.value === "disease" ||
    match.value === "breeding" ||
    match.value === "evolution" ||
    match.value === "basic_biology"
  );
  const selectedResearch = substantiveMatch ?? preferredMatch ?? researchMatches[0];

  return {
    speciesContext,
    researchContext: selectedResearch?.value ?? categoryContext ?? "unknown",
    speciesEvidence,
    researchEvidence: unique([
      ...(categoryContext ? [`structured:${candidate.researchCategory}`] : []),
      ...(selectedResearch?.evidence ?? [])
    ])
  };
}

function categoryToResearchContext(
  category: SourceRankingCandidateSnapshot["researchCategory"]
): ResearchContext | undefined {
  if (category === "method" || category === "benchmark") return "method";
  if (category === "resource") return "resource";
  return undefined;
}

function matchingTerms(text: string, terms: readonly string[]): string[] {
  return terms.filter((term) => containsPhrase(text, normalize(term)));
}

function containsPhrase(text: string, phrase: string): boolean {
  return ` ${text} `.includes(` ${phrase} `);
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/-/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
