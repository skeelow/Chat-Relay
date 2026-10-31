// Stand-in for a leaked relay shell: runs until something kills it.
// argv[2] is whatever path the test wants on its command line (the marker
// form or a look-alike without the marker).
const hold = setInterval(() => {}, 60_000);
void hold;
