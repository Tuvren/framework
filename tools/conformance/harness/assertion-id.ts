export const assertionId = (
  checkId: string,
  index: number,
  kind: string,
  stepId?: string
): string =>
  `${checkId}${stepId === undefined ? "" : `.${stepId}`}.${index + 1}.${kind}`;
