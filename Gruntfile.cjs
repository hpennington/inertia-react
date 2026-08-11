module.exports = function(grunt) {
  grunt.initConfig({
    ts: {
      default: {
        tsconfig: true,
        src: ['src/**/*.ts', 'src/**/*.tsx'],
        dest: 'dist',
        options: {
          sourceMap: true,
          declaration: true,
          outDir: 'dist',
          module: 'es6'
        },
      }
    },
    uglify: {
      inertia: {
        files: {
          'dist/index.min.js': ['dist/index.js']
        }
      }
    },
    watch: {
      scripts: {
        files: ['src/**/*.ts', 'src/**/*.tsx'], // Watch for changes in these files
        tasks: ['ts', 'uglify'], // Run these tasks when changes are detected
        options: {
          spawn: false,
        },
      },
    }
  });

  // Load the plugins
  grunt.loadNpmTasks('grunt-ts');
  grunt.loadNpmTasks('grunt-contrib-uglify');
  grunt.loadNpmTasks('grunt-contrib-watch');

  // libinertia's wasm module and its emscripten glue, dropped into src/wasm by
  // `make web-runtime` in the inertia-app repository. tsc leaves both alone —
  // one is generated JavaScript and the other a binary — so the compiled output
  // needs them copied across beside it, at the same relative path src/inertia.ts
  // imports them by.
  //
  // grunt.file rather than grunt-contrib-copy: this is two files, and it is not
  // worth a dependency.
  grunt.registerTask('wasm', 'Copy libinertia into dist', function() {
    grunt.file.recurse('src/wasm', function(abspath, rootdir, subdir, filename) {
      grunt.file.copy(abspath, 'dist/wasm/' + filename);
    });
  });

  // Default tasks
  grunt.registerTask('default', ['ts', 'wasm', 'uglify']);
};
