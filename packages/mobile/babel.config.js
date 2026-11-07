module.exports = function (api) {
  api.cache(true);
  return {
    presets: [
      [
        "babel-preset-expo",
        {
          // Keep Metro able to parse import.meta if a dependency ships one.
          unstable_transformImportMeta: true,
        },
      ],
    ],
  };
};
