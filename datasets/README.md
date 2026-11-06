Datasets each instance builds for itself: `datasets/<name>/build.sh`, as in Pacha. What a
script writes is git-ignored and served by Pacha's gateway at
`http://feeds/datasets/<name>/<file>.parquet`, after Pacha's own datasets.
