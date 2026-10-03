export const KG_TO_LB_FACTOR = 2.20462262185;
export const CUBIC_FEET_PER_CBM = 35.3146667;
export const DEFAULT_SEA_VOLUMETRIC_FACTOR_KG_PER_CBM = 200;
export const DEFAULT_AIR_DIMENSIONAL_DIVISOR = 6000;
export const DIMENSION_CONVERSION_FACTORS = {
  cm: 0.01,
  m: 1,
  mm: 0.001,
  inch: 0.0254,
  ft: 0.3048,
};
export const CONTAINER_USABLE_CBM = {
  twentyFt: 28.188,
  fortyFt: 59.616,
  fortyFtHighCube: 67.878,
};

export const kgToLb = (value) => sanitizeNonNegative(value) * KG_TO_LB_FACTOR;
export const lbToKg = (value) => sanitizeNonNegative(value) / KG_TO_LB_FACTOR;

export function sanitizeNonNegative(value, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return fallback;
  return numeric;
}

export function sanitizePositiveWholeQuantity(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0 || !Number.isInteger(numeric)) return fallback;
  return numeric;
}

export function normalizeDimensionToMeters(value, unit = 'm') {
  const numeric = sanitizeNonNegative(value, 0);
  const factor = DIMENSION_CONVERSION_FACTORS[unit] ?? DIMENSION_CONVERSION_FACTORS.m;
  return numeric * factor;
}

export function calculateCbm({ length, width, height, unit = 'cm', quantity = 1 }) {
  const lengthMeters = normalizeDimensionToMeters(length, unit);
  const widthMeters = normalizeDimensionToMeters(width, unit);
  const heightMeters = normalizeDimensionToMeters(height, unit);
  const qty = sanitizePositiveWholeQuantity(quantity, 0);

  if (lengthMeters === 0 || widthMeters === 0 || heightMeters === 0 || qty === 0) {
    return {
      lengthInMeters: lengthMeters,
      widthInMeters: widthMeters,
      heightInMeters: heightMeters,
      quantity: qty,
      cbmPerCarton: 0,
      totalCbm: 0,
    };
  }

  const cbmPerCarton = lengthMeters * widthMeters * heightMeters;

  return {
    lengthInMeters: lengthMeters,
    widthInMeters: widthMeters,
    heightInMeters: heightMeters,
    quantity: qty,
    cbmPerCarton,
    totalCbm: cbmPerCarton * qty,
  };
}

export function calculateActualWeight({ weightPerCarton, weightUnit = 'kg', quantity = 1 }) {
  const qty = sanitizePositiveWholeQuantity(quantity, 0);
  const weightValue = sanitizeNonNegative(weightPerCarton, 0);

  if (qty === 0) {
    return {
      totalActualWeightKg: 0,
      totalActualWeightLb: 0,
    };
  }

  const totalWeightKg = weightUnit === 'kg'
    ? weightValue * qty
    : lbToKg(weightValue * qty);

  return {
    totalActualWeightKg: totalWeightKg,
    totalActualWeightLb: kgToLb(totalWeightKg),
  };
}

export function calculateSeaVolumetricWeight({ totalCbm, seaVolumetricFactorKgPerCbm = DEFAULT_SEA_VOLUMETRIC_FACTOR_KG_PER_CBM }) {
  const safeTotalCbm = sanitizeNonNegative(totalCbm, 0);
  const seaVolumetricWeightKg = safeTotalCbm * seaVolumetricFactorKgPerCbm;
  return {
    seaVolumetricWeightKg,
    seaVolumetricWeightLb: kgToLb(seaVolumetricWeightKg),
  };
}

export function calculateAirVolumetricWeight({ length, width, height, unit = 'cm', quantity = 1, totalCbm = 0, divisor = DEFAULT_AIR_DIMENSIONAL_DIVISOR }) {
  const qty = sanitizePositiveWholeQuantity(quantity, 0);
  const safeDivisor = sanitizePositiveWholeQuantity(divisor, DEFAULT_AIR_DIMENSIONAL_DIVISOR);

  if (qty === 0) {
    return {
      airVolumetricWeightKg: 0,
      airVolumetricWeightLb: 0,
    };
  }

  const lengthCm = normalizeDimensionToMeters(length, unit) * 100;
  const widthCm = normalizeDimensionToMeters(width, unit) * 100;
  const heightCm = normalizeDimensionToMeters(height, unit) * 100;

  if (lengthCm === 0 || widthCm === 0 || heightCm === 0) {
    const safeTotalCbmValue = sanitizeNonNegative(totalCbm, 0);
    const fallbackAirWeightKg = safeTotalCbmValue * (1000000 / safeDivisor);
    return {
      airVolumetricWeightKg: fallbackAirWeightKg,
      airVolumetricWeightLb: kgToLb(fallbackAirWeightKg),
    };
  }

  const airVolumetricWeightKg = (lengthCm * widthCm * heightCm * qty) / safeDivisor;

  return {
    airVolumetricWeightKg,
    airVolumetricWeightLb: kgToLb(airVolumetricWeightKg),
  };
}

export function calculateChargeableAirWeight({ totalActualWeightKg, airVolumetricWeightKg }) {
  const actualKg = sanitizeNonNegative(totalActualWeightKg, 0);
  const volumetricKg = sanitizeNonNegative(airVolumetricWeightKg, 0);
  const chargeableAirWeightKg = Math.max(actualKg, volumetricKg);

  return {
    chargeableAirWeightKg,
    chargeableAirWeightLb: kgToLb(chargeableAirWeightKg),
  };
}

export function estimateContainerCartons({ cbmPerCarton, containerUsableCbm = CONTAINER_USABLE_CBM }) {
  const cartonCbm = sanitizeNonNegative(cbmPerCarton, 0);
  if (cartonCbm <= 0) {
    return {
      twentyFt: 0,
      fortyFt: 0,
      fortyFtHighCube: 0,
    };
  }

  return {
    twentyFt: Math.floor(containerUsableCbm.twentyFt / cartonCbm),
    fortyFt: Math.floor(containerUsableCbm.fortyFt / cartonCbm),
    fortyFtHighCube: Math.floor(containerUsableCbm.fortyFtHighCube / cartonCbm),
  };
}

export function calculateCbmMetrics({
  length,
  width,
  height,
  unit = 'cm',
  weightPerCarton = '',
  weightUnit = 'kg',
  quantity = 1,
  seaVolumetricFactorKgPerCbm = DEFAULT_SEA_VOLUMETRIC_FACTOR_KG_PER_CBM,
  airDimensionalDivisor = DEFAULT_AIR_DIMENSIONAL_DIVISOR,
}) {
  const cbm = calculateCbm({ length, width, height, unit, quantity });
  const actualWeight = calculateActualWeight({
    weightPerCarton,
    weightUnit,
    quantity: cbm.quantity || sanitizePositiveWholeQuantity(quantity, 0),
  });
  const seaVolumetricWeight = calculateSeaVolumetricWeight({
    totalCbm: cbm.totalCbm,
    seaVolumetricFactorKgPerCbm,
  });
  const airVolumetricWeight = calculateAirVolumetricWeight({
    length,
    width,
    height,
    unit,
    quantity: cbm.quantity || sanitizePositiveWholeQuantity(quantity, 0),
    totalCbm: cbm.totalCbm,
    divisor: airDimensionalDivisor,
  });
  const chargeableAirWeight = calculateChargeableAirWeight({
    totalActualWeightKg: actualWeight.totalActualWeightKg,
    airVolumetricWeightKg: airVolumetricWeight.airVolumetricWeightKg,
  });

  const cubicFeet = cbm.totalCbm * CUBIC_FEET_PER_CBM;

  return {
    ...cbm,
    actualWeightKg: actualWeight.totalActualWeightKg,
    actualWeightLb: actualWeight.totalActualWeightLb,
    seaVolumetricWeightKg: seaVolumetricWeight.seaVolumetricWeightKg,
    seaVolumetricWeightLb: seaVolumetricWeight.seaVolumetricWeightLb,
    airVolumetricWeightKg: airVolumetricWeight.airVolumetricWeightKg,
    airVolumetricWeightLb: airVolumetricWeight.airVolumetricWeightLb,
    chargeableAirWeightKg: chargeableAirWeight.chargeableAirWeightKg,
    chargeableAirWeightLb: chargeableAirWeight.chargeableAirWeightLb,
    cubicFeet,
    containerEstimates: estimateContainerCartons({ cbmPerCarton: cbm.cbmPerCarton }),
  };
}
