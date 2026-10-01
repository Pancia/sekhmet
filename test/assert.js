// Smallest thing that can fail a build. No dependencies, on purpose: this repo
// has no package.json and adding one to run four dozen assertions would be a
// worse trade than writing the eight lines.
let fails = 0;

exports.group = name => console.log('\n' + name);

exports.ok = (label, cond) => {
    console.log((cond ? '  pass  ' : '  FAIL  ') + label);
    if (!cond) fails++;
};

exports.done = () => {
    console.log(fails ? `\n${fails} FAILED` : '\nall pass');
    process.exit(fails ? 1 : 0);
};
