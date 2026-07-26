const EPSILON = 1e-9;

export type CappedCreditAllocation = {
  allocationId: string;
  allocatedUnits: number;
};

export type CappedCreditConstraint = {
  requirementId: string;
  maximumUnits: number;
  matches: Array<{
    allocationId: string;
    matchedUnits: number;
  }>;
};

function simplexMaximum(
  coefficients: number[][],
  limits: number[],
  objective: number[],
) {
  const constraintCount = coefficients.length;
  const variableCount = objective.length;
  const rightHandSide = variableCount + constraintCount;
  const tableau = Array.from(
    { length: constraintCount + 1 },
    () => Array(rightHandSide + 1).fill(0),
  );

  coefficients.forEach((row, rowIndex) => {
    row.forEach((value, columnIndex) => {
      tableau[rowIndex][columnIndex] = value;
    });
    tableau[rowIndex][variableCount + rowIndex] = 1;
    tableau[rowIndex][rightHandSide] = Math.max(
      0,
      limits[rowIndex] ?? 0,
    );
  });
  objective.forEach((value, columnIndex) => {
    tableau[constraintCount][columnIndex] = -value;
  });

  const pivot = (leavingRow: number, enteringColumn: number) => {
    const pivotValue = tableau[leavingRow][enteringColumn];
    for (let column = 0; column <= rightHandSide; column += 1) {
      tableau[leavingRow][column] /= pivotValue;
    }
    for (let row = 0; row <= constraintCount; row += 1) {
      if (row === leavingRow) continue;
      const factor = tableau[row][enteringColumn];
      if (Math.abs(factor) <= EPSILON) continue;
      for (let column = 0; column <= rightHandSide; column += 1) {
        tableau[row][column] -=
          factor * tableau[leavingRow][column];
      }
    }
  };

  const maximumPivots =
    Math.max(1, constraintCount * (variableCount + constraintCount)) *
    4;
  for (let iteration = 0; iteration < maximumPivots; iteration += 1) {
    const objectiveRow = tableau[constraintCount];
    const enteringColumn = objectiveRow.findIndex(
      (value, columnIndex) =>
        columnIndex < rightHandSide && value < -EPSILON,
    );
    if (enteringColumn === -1) {
      return Math.max(0, objectiveRow[rightHandSide]);
    }

    let leavingRow = -1;
    let smallestRatio = Number.POSITIVE_INFINITY;
    for (let row = 0; row < constraintCount; row += 1) {
      const divisor = tableau[row][enteringColumn];
      if (divisor <= EPSILON) continue;
      const ratio = tableau[row][rightHandSide] / divisor;
      if (ratio < smallestRatio - EPSILON) {
        smallestRatio = ratio;
        leavingRow = row;
      }
    }
    if (leavingRow === -1) {
      throw new Error("Capped-credit model is unbounded");
    }
    pivot(leavingRow, enteringColumn);
  }
  throw new Error("Capped-credit model did not converge");
}

export function cappedCreditTotals(
  allocations: readonly CappedCreditAllocation[],
  constraints: readonly CappedCreditConstraint[],
) {
  const allocationUnits = new Map<string, number>();
  for (const allocation of allocations) {
    allocationUnits.set(
      allocation.allocationId,
      Math.max(0, Number(allocation.allocatedUnits) || 0),
    );
  }
  const normalizedConstraints = constraints.map((constraint) => {
    const membership = new Set<string>();
    for (const match of constraint.matches) {
      const units = allocationUnits.get(match.allocationId);
      if (units === undefined || units <= EPSILON) continue;
      const matchedUnits = Math.max(0, Number(match.matchedUnits) || 0);
      if (matchedUnits <= EPSILON) continue;
      if (Math.abs(matchedUnits - units) > EPSILON) {
        throw new Error(
          `Capped requirement ${constraint.requirementId} has a partial allocation match`,
        );
      }
      membership.add(match.allocationId);
    }
    return {
      requirementId: constraint.requirementId,
      maximumUnits: Math.max(
        0,
        Number(constraint.maximumUnits) || 0,
      ),
      membership,
    };
  });

  const unitsBySignature = new Map<string, number>();
  for (const [allocationId, units] of allocationUnits) {
    if (units <= EPSILON) continue;
    const signature = normalizedConstraints
      .map((constraint, index) =>
        constraint.membership.has(allocationId) ? index : -1,
      )
      .filter((index) => index >= 0)
      .join(",");
    unitsBySignature.set(
      signature,
      (unitsBySignature.get(signature) ?? 0) + units,
    );
  }
  const signatures = [...unitsBySignature.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([signature, units]) => ({
      constraintIndexes: signature
        ? signature.split(",").map(Number)
        : [],
      units,
    }));
  const totalUnits = signatures.reduce(
    (sum, signature) => sum + signature.units,
    0,
  );
  if (signatures.length === 0 || normalizedConstraints.length === 0) {
    return {
      countableUnits: totalUnits,
      excludedUnits: 0,
    };
  }

  const coefficients: number[][] = [];
  const limits: number[] = [];
  normalizedConstraints.forEach((constraint, constraintIndex) => {
    coefficients.push(
      signatures.map((signature) =>
        signature.constraintIndexes.includes(constraintIndex) ? 1 : 0,
      ),
    );
    limits.push(constraint.maximumUnits);
  });
  signatures.forEach((signature, signatureIndex) => {
    coefficients.push(
      signatures.map((_, candidateIndex) =>
        candidateIndex === signatureIndex ? 1 : 0,
      ),
    );
    limits.push(signature.units);
  });

  const countableUnits = Math.min(
    totalUnits,
    simplexMaximum(
      coefficients,
      limits,
      signatures.map(() => 1),
    ),
  );
  return {
    countableUnits,
    excludedUnits: Math.max(0, totalUnits - countableUnits),
  };
}
