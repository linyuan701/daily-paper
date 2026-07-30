import { describe, expect, it } from "vitest";

import { classifyDiagnosticContext } from "./context-classifier";

describe("classifyDiagnosticContext", () => {
  it("distinguishes the requested species contexts", () => {
    expect(classifyDiagnosticContext({ title: "Human cancer cohort" }).speciesContext).toBe("human");
    expect(classifyDiagnosticContext({ title: "Genomic prediction in cattle" }).speciesContext).toBe("livestock");
    expect(classifyDiagnosticContext({ title: "Chromatin regulation in mice" }).speciesContext).toBe("model_organism");
    expect(classifyDiagnosticContext({ title: "Gene regulation in rice plants" }).speciesContext).toBe("plant");
    expect(classifyDiagnosticContext({ title: "Cross-species atlas of human and mouse cells" }).speciesContext)
      .toBe("cross_species");
    expect(classifyDiagnosticContext({ title: "A statistical note" }).speciesContext).toBe("unknown");
  });

  it("distinguishes the requested research contexts", () => {
    expect(classifyDiagnosticContext({ title: "Cancer pathogenesis" }).researchContext).toBe("disease");
    expect(classifyDiagnosticContext({ title: "Chromatin mechanism" }).researchContext).toBe("basic_biology");
    expect(classifyDiagnosticContext({ title: "Genomic selection for breeding" }).researchContext).toBe("breeding");
    expect(classifyDiagnosticContext({ title: "Phylogenetic evolution" }).researchContext).toBe("evolution");
    expect(classifyDiagnosticContext({ title: "New inference algorithm" }).researchContext).toBe("method");
    expect(classifyDiagnosticContext({ title: "A public cell atlas resource" }).researchContext).toBe("resource");
    expect(classifyDiagnosticContext({ title: "Observations" }).researchContext).toBe("unknown");
  });

  it("uses existing structured method/resource labels as diagnostic evidence", () => {
    const context = classifyDiagnosticContext({
      title: "Statistical phenotype prediction",
      researchCategory: "method"
    });

    expect(context.researchContext).toBe("method");
    expect(context.researchEvidence).toContain("structured:method");
  });
});
