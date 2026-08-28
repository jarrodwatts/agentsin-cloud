def fail_invariant($message):
  error("Protected worker isolation invariant failed: " + $message);

def require($condition; $message):
  if $condition then . else fail_invariant($message) end;

def option_set($value):
  if ($value | type) == "string" then
    $value | split(",") | map(select(length > 0)) | sort
  else
    []
  end;

require(type == "array" and length == 1; "Docker inspect returned an unexpected container count")
| .[0]
| require(.HostConfig.Binds == null; "bind mounts are configured")
| require((.HostConfig.Mounts // []) == []; "structured mounts are configured")
| require((.HostConfig.VolumesFrom // []) == []; "volumes-from is configured")
| require(.Config.Volumes == null; "image-declared volumes are configured")
| require((.HostConfig.Tmpfs | type) == "object"; "tmpfs configuration is missing")
| require(
    (.HostConfig.Tmpfs | keys) == ["/tmp", "/work"];
    "tmpfs destinations must be exactly /tmp and /work"
  )
| require(
    option_set(.HostConfig.Tmpfs["/tmp"])
      == (["rw", "noexec", "nosuid", "nodev", "size=64m", "mode=1777"] | sort);
    "/tmp tmpfs options must be rw,noexec,nosuid,nodev,size=64m,mode=1777"
  )
| require(
    option_set(.HostConfig.Tmpfs["/work"])
      == (["rw", "noexec", "nosuid", "nodev", "size=4g", "mode=1777"] | sort);
    "/work tmpfs options must be rw,noexec,nosuid,nodev,size=4g,mode=1777"
  )
| require((.Mounts | type) == "array"; "runtime mount report is missing")
| require((.Mounts | length) == 2; "runtime mounts must contain exactly two entries")
| require(all(.Mounts[]; .Type == "tmpfs"); "a bind or volume runtime mount is present")
| require(
    (.Mounts | map(.Destination) | sort) == ["/tmp", "/work"];
    "runtime mount destinations must be exactly /tmp and /work"
  )
| require(all(.Mounts[]; .Source == ""); "a runtime mount exposes a source or host path")
| require(all(.Mounts[]; .RW == true); "an authorized tmpfs is not writable")
| require(all(.Mounts[]; (.Mode // "") == ""); "an authorized tmpfs has an unexpected mode field")
| require(
    all(.Mounts[]; (.Propagation // "") == "");
    "an authorized tmpfs has unexpected propagation"
  )
