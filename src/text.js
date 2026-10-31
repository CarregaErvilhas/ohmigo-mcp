// Text matching without accents or case: "São João" and "sao joao" are the
// same to a driver. A leaf module, so a script can use it without loading the
// charger search and the data files behind it.

export const fold = s => (s || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
