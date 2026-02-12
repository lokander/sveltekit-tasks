<script lang="ts">
  // @ts-expect-error — MDsveX handles .md imports at build time
  import Readme from "../../README.md";
</script>

<div class="mx-auto my-4 prose max-w-4xl rounded bg-base-100 p-8">
  <Readme />
</div>
