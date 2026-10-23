use std::hint::black_box;
use std::time::Instant;

use tuvren_kernel_rust::{InMemoryKernel, KernelResult};

fn main() -> KernelResult<()> {
    let kernel = InMemoryKernel::new();
    let mut hash = String::new();
    for index in 0_u64..2500 {
        let mut blob = vec![0; 16 * 1024];
        blob[..8].copy_from_slice(&index.to_le_bytes());
        hash = kernel.store_put(blob, None)?;
    }
    for _ in 0..20 {
        assert!(kernel.store_has(black_box(&hash))?);
    }
    let iterations = 200;
    let start = Instant::now();
    for _ in 0..iterations {
        assert!(black_box(kernel.store_has(black_box(&hash))?));
    }
    println!(
        "2500 distinct 16 KiB objects; {iterations} store_has calls; {:.6} ms/call",
        start.elapsed().as_secs_f64() * 1000.0 / f64::from(iterations)
    );
    Ok(())
}
